import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addTask,
  ensureNativeHelper,
  getNativeHelperStatus,
  getStateSnapshot,
  openDownloadsFolder,
  openTaskFile,
  pauseAllTasks,
  pauseTask,
  removeTask,
  resumeAllTasks,
  resumeTask,
  revealTaskFile,
  subscribeTaskEvents,
  updateSettings,
} from "../shared/client";
import type { NativeHelperStatus } from "../shared/protocol";
import { parseTorrentBuffer, uint8ArrayToBase64 } from "../engine/torrent/parser";
import { AgentInstallModal } from "../shared/components/AgentInstallModal";
import { SegmentBar } from "../shared/components/SegmentBar";
import {
  calcProgressPercent,
  formatBytes,
  formatEta,
  formatSpeed,
} from "../shared/format";
import {
  ExternalIcon,
  FolderIcon,
  InfoIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from "../shared/icons";
import { I18nProvider, useI18n } from "../shared/i18n";
import {
  DEFAULT_SETTINGS,
  isActiveTaskState,
  canOpenTaskFile,
  type AddTaskInput,
  type AppInfo,
  type Settings,
  type TaskView,
} from "../shared/types";
import { AddTaskModal } from "./AddTaskModal";
import { SettingsView } from "./SettingsView";
import { TaskDetailsModal } from "./TaskDetailsModal";

export type NavView = "overview" | "all" | "active" | "completed" | "settings";

function isCompleted(t: TaskView): boolean {
  return t.state === "completed" || t.state === "seeding";
}

function ManagerInner({
  initialView = "overview",
  settings,
  info,
  tasks,
  helperStatus,
  wakingHelper,
  onWakeHelper,
  onRefresh,
  onUpdateSettings,
}: {
  initialView?: NavView;
  settings: Settings;
  info: AppInfo | null;
  tasks: TaskView[];
  helperStatus: NativeHelperStatus | null;
  wakingHelper: boolean;
  onWakeHelper: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onUpdateSettings: (patch: Partial<Settings>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<NavView>(initialView);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"recent" | "speed" | "name">("recent");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [quickUrl, setQuickUrl] = useState("");
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addInitialUrl, setAddInitialUrl] = useState<string | null>(null);
  const [addInitialTorrentFile, setAddInitialTorrentFile] = useState<File | null>(null);
  const [detailsTask, setDetailsTask] = useState<TaskView | null>(null);
  const [removeTarget, setRemoveTarget] = useState<TaskView | null>(null);
  const [deleteFilesCheck, setDeleteFilesCheck] = useState(false);
  const [dragging, setDragging] = useState(false);
  const torrentInputRef = useRef<HTMLInputElement | null>(null);

  // 支持从 URL 参数 ?add=... 自动拉起新建弹窗
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const addParam = params.get("add");
    if (addParam) {
      setAddInitialTorrentFile(null);
      setAddInitialUrl(addParam);
      setAddModalOpen(true);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  const counts = useMemo(() => {
    const completed = tasks.filter(isCompleted).length;
    const active = tasks.length - completed;
    return {
      all: tasks.length,
      active,
      completed,
    };
  }, [tasks]);

  const totalDownSpeed = useMemo(
    () => tasks.reduce((sum, item) => sum + (item.speedBps || 0), 0),
    [tasks],
  );

  const visibleTasks = useMemo(() => {
    const base = tasks.filter((item) => {
      if (view === "active") return !isCompleted(item);
      if (view === "completed") return isCompleted(item);
      return true;
    });
    const q = query.trim().toLowerCase();
    const filtered = q
      ? base.filter(
          (item) =>
            item.name.toLowerCase().includes(q) ||
            item.url.toLowerCase().includes(q) ||
            (item.error ?? "").toLowerCase().includes(q),
        )
      : base;

    return [...filtered].sort((a, b) => {
      if (sort === "speed") return b.speedBps - a.speedBps;
      if (sort === "name") return a.name.localeCompare(b.name);
      return b.createdAt - a.createdAt || b.id - a.id;
    });
  }, [tasks, view, query, sort]);

  const handleQuickAdd = async () => {
    const trimmed = quickUrl.trim();
    if (!trimmed) {
      setAddInitialTorrentFile(null);
      setAddInitialUrl(null);
      setAddModalOpen(true);
      return;
    }
    if (/^https?:\/\/.+\.torrent($|[?#])/i.test(trimmed)) {
      try {
        const res = await fetch(trimmed);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        const meta = await parseTorrentBuffer(buf);
        if (meta.files.length <= 1) {
          await addTask({
            url: trimmed,
            fileName: meta.name,
            torrentBytesBase64: uint8ArrayToBase64(buf),
          });
          setQuickUrl("");
          await onRefresh();
          return;
        }
      } catch {
        // 拉取/解析失败或包含多个文件时打开弹窗让用户确认
      }
      setAddInitialTorrentFile(null);
      setAddInitialUrl(trimmed);
      setAddModalOpen(true);
      setQuickUrl("");
      return;
    }
    try {
      await addTask({ url: trimmed });
      setQuickUrl("");
      await onRefresh();
    } catch {
      setAddInitialTorrentFile(null);
      setAddInitialUrl(trimmed);
      setAddModalOpen(true);
    }
  };

  const handleDropTorrent = async (file: File) => {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const meta = await parseTorrentBuffer(buf);
      if (meta.files.length <= 1) {
        await addTask({
          url: "",
          fileName: file.name.replace(/\.torrent$/i, "") || meta.name,
          torrentBytesBase64: uint8ArrayToBase64(buf),
        });
        await onRefresh();
        return;
      }
    } catch {
      // 解析失败或包含多个文件时打开弹窗让用户确认
    }
    setAddInitialUrl(null);
    setAddInitialTorrentFile(file);
    setAddModalOpen(true);
  };

  const renderTaskRow = (task: TaskView, showCheckbox = true) => {
    const pct = calcProgressPercent(task.downloaded, task.total);
    const speed = formatSpeed(task.speedBps);
    const done = isCompleted(task);
    const active = isActiveTaskState(task.state);

    return (
      <div
        key={task.id}
        className={`task-item ${selectedIds.has(task.id) ? "selected" : ""}`}
        style={{
          gridTemplateColumns: showCheckbox
            ? "24px 38px minmax(0, 1fr) 120px auto"
            : "38px minmax(0, 1fr) 120px auto",
        }}
      >
        {showCheckbox && (
          <input
            type="checkbox"
            checked={selectedIds.has(task.id)}
            onChange={() => {
              setSelectedIds((prev) => {
                const next = new Set(prev);
                if (next.has(task.id)) next.delete(task.id);
                else next.add(task.id);
                return next;
              });
            }}
          />
        )}

        <div className={`task-icon ${task.kind === "http" ? "http" : ""}`}>
          {task.kind === "torrent" ? "BT" : "HTTP"}
        </div>

        <div style={{ minWidth: 0 }}>
          <div className="task-title-row">
            <span className="task-name" title={task.name}>
              {task.name}
            </span>
            <span className={`state-tag ${task.state}`}>
              {t(`task.state.${task.state}`)}
            </span>
          </div>

          <div style={{ marginTop: "6px" }}>
            <SegmentBar task={task} />
          </div>

          <div className="task-meta-row">
            <span>
              {formatBytes(task.downloaded)} / {formatBytes(task.total)} ({pct.toFixed(1)}%)
            </span>
            {task.kind === "http" && (
              <span>{t("task.connections", { count: task.connections })}</span>
            )}
            {task.kind === "torrent" && (
              <span>{t("task.peers", { count: task.peers ?? 0 })}</span>
            )}
            {active && task.etaSecs !== null && (
              <span>ETA {formatEta(task.etaSecs)}</span>
            )}
            {task.error && (
              <span className="task-error-msg">{task.error}</span>
            )}
          </div>
        </div>

        <div className="task-speed-col">
          <strong>{active ? speed.full : done ? "100%" : "—"}</strong>
          <span>{task.saveDir || "Downloads"}</span>
        </div>

        <div className="task-actions">
          <button
            type="button"
            className="icon-btn"
            title={t("task.details")}
            onClick={() => setDetailsTask(task)}
          >
            <InfoIcon />
          </button>

          {!done && (
            <button
              type="button"
              className="icon-btn"
              title={active ? t("task.pause") : t("task.resume")}
              onClick={async () => {
                if (active) await pauseTask(task.id);
                else await resumeTask(task.id);
                await onRefresh();
              }}
            >
              {active ? <PauseIcon /> : <PlayIcon />}
            </button>
          )}

          {done && (
            <>
              {canOpenTaskFile(task) && (
              <button
                type="button"
                className="icon-btn"
                title={t("task.open")}
                onClick={() =>
                  void openTaskFile(task).catch((err) =>
                    window.alert(err instanceof Error ? err.message : String(err)),
                  )
                }
              >
                <ExternalIcon />
              </button>
              )}
              <button
                type="button"
                className="icon-btn"
                title={t("task.openFolder")}
                onClick={() =>
                  void revealTaskFile(task).catch((err) =>
                    window.alert(err instanceof Error ? err.message : String(err)),
                  )
                }
              >
                <FolderIcon />
              </button>
            </>
          )}

          <button
            type="button"
            className="icon-btn danger"
            title={t("task.remove")}
            onClick={() => {
              setDeleteFilesCheck(false);
              setRemoveTarget(task);
            }}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    );
  };

  const formattedTotalSpeed = formatSpeed(totalDownSpeed);

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = Array.from(e.dataTransfer.files).find((f) =>
          f.name.toLowerCase().endsWith(".torrent"),
        );
        if (file) {
          void handleDropTorrent(file);
        }
      }}
    >
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <img src="/icons/icon-128.png" alt="Tug Web" />
          </div>
          <div>
            <div className="brand-name">{t("app.name")}</div>
            <div className="brand-tagline">{t("app.tagline")}</div>
          </div>
        </div>

        <nav className="nav">
          {(
            [
              ["overview", t("nav.overview"), null],
              ["all", t("nav.all"), counts.all],
              ["active", t("nav.active"), counts.active],
              ["completed", t("nav.completed"), counts.completed],
              ["settings", t("nav.settings"), null],
            ] as Array<[NavView, string, number | null]>
          ).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              className={`nav-item ${view === id ? "active" : ""}`}
              onClick={() => {
                setView(id);
                setSelectedIds(new Set());
              }}
            >
              <span className="nav-label-text">{label}</span>
              {count !== null && <span className="nav-count">{count}</span>}
            </button>
          ))}
        </nav>

        <div className="side-storage">
          <div className="side-storage-label">{t("overview.storage")}</div>
          <div className="side-storage-path">{t("overview.storageValue")}</div>
          <div className="side-storage-meta">
            <span>{t("overview.stat.intercept")}</span>
            <b className={settings.autoInterceptDownloads ? "ok" : "muted"}>
              {settings.autoInterceptDownloads
                ? t("overview.interceptOn")
                : t("overview.interceptOff")}
            </b>
          </div>
          <div className="side-storage-meta" style={{ marginTop: "6px" }}>
            <span>{t("sidebar.standaloneLabel")}</span>
            <b
              className={settings.standaloneMode ? "muted" : "ok"}
              style={{
                cursor: "pointer",
                textDecoration: "underline",
              }}
              onClick={() =>
                void onUpdateSettings({ standaloneMode: !settings.standaloneMode })
              }
            >
              {settings.standaloneMode
                ? t("sidebar.standaloneOn")
                : t("sidebar.standaloneOff")}
            </b>
          </div>
          <div className="side-storage-meta" style={{ marginTop: "6px" }}>
            <span>{t("sidebar.helperLabel")}</span>
            {settings.standaloneMode ? (
              <b className="muted">{t("sidebar.helperDisabled")}</b>
            ) : helperStatus?.available ? (
              <b className="ok">
                ● {t("sidebar.helperConnected", { port: helperStatus.port ?? 16899 })}
              </b>
            ) : (
              <b
                style={{
                  cursor: "pointer",
                  color: "var(--accent)",
                  textDecoration: "underline",
                }}
                onClick={() => void onWakeHelper()}
              >
                {wakingHelper ? t("sidebar.helperConnecting") : helperStatus?.updateRequired
                  ? t("sidebar.helperUpdateRequired") : t("sidebar.helperStandby")}
              </b>
            )}
          </div>
        </div>

        <div className="sidebar-footer">
          <div className="sidebar-status">
            <span className="status-dot" />
            <span>{t("status.ready")}</span>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="page-title">
            <h1>{t(`toolbar.title.${view}`)}</h1>
          </div>

          <div className="topbar-spacer" />

          {view !== "settings" && (
            <label className="search">
              <SearchIcon />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("toolbar.search")}
              />
            </label>
          )}

          <button
            type="button"
            className="btn"
            onClick={() => void openDownloadsFolder(settings.standaloneMode)}
          >
            <FolderIcon />
            <span>{t("toolbar.openFolder")}</span>
          </button>

          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setAddInitialTorrentFile(null);
              setAddInitialUrl(null);
              setAddModalOpen(true);
            }}
          >
            <PlusIcon />
            <span>{t("toolbar.new")}</span>
          </button>
        </header>

        <main className="content">
          {!settings.standaloneMode && helperStatus && !helperStatus.available && view !== "settings" && (
            <div
              className="card"
              style={{
                marginBottom: "14px",
                padding: "12px 16px",
                display: "flex",
                alignItems: "center",
                gap: "12px",
                flexWrap: "wrap",
                borderLeft: "3px solid var(--accent)",
                background: "var(--bg-soft)",
              }}
            >
              <div style={{ flex: 1, minWidth: "240px" }}>
                <div style={{ fontWeight: 700, fontSize: "13px", marginBottom: "3px" }}>
                  ⚡ {t("overview.helperBannerTitle")}
                </div>
                <div className="muted" style={{ fontSize: "11.5px", lineHeight: 1.45 }}>
                  {t("overview.helperBannerDesc")}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void onUpdateSettings({ standaloneMode: true })}
                >
                  {t("overview.helperUseStandaloneBtn")}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={wakingHelper}
                  onClick={() => void onWakeHelper()}
                >
                  {wakingHelper ? t("sidebar.helperConnecting") : t("overview.helperBannerBtn")}
                </button>
              </div>
            </div>
          )}

          {view === "overview" && (
            <div className="overview-grid">
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <div className="card hero-card">
                  <div className="hero-kicker">TUG WEB ENGINE · MV3</div>
                  <h2>{t("overview.heroLead")}</h2>
                  <p>{t("overview.heroDesc")}</p>

                  <div className="quick-add">
                    <input
                      type="text"
                      value={quickUrl}
                      onChange={(e) => setQuickUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleQuickAdd();
                      }}
                      placeholder={t("overview.quickPlaceholder")}
                    />
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => void handleQuickAdd()}
                    >
                      {t("overview.quickStart")}
                    </button>
                  </div>

                  <input
                    ref={torrentInputRef}
                    type="file"
                    accept=".torrent,application/x-bittorrent"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.currentTarget.value = "";
                      if (f) handleDropTorrent(f);
                    }}
                  />
                  <button
                    type="button"
                    className={`drop-zone ${dragging ? "dragging" : ""}`}
                    onClick={() => torrentInputRef.current?.click()}
                  >
                    <span className="drop-plus">+</span>
                    <span>
                      <b style={{ display: "block", fontSize: "12px" }}>
                        {t("overview.dropTitle")}
                      </b>
                      <span className="hint">{t("overview.dropHint")}</span>
                    </span>
                  </button>

                  <div className="hero-stats">
                    <div className="hero-stat">
                      <span>{t("overview.stat.speed")}</span>
                      <strong>
                        {formattedTotalSpeed.value}{" "}
                        <small className="muted" style={{ fontSize: "11px" }}>
                          {formattedTotalSpeed.unit}
                        </small>
                      </strong>
                    </div>
                    <div className="hero-stat">
                      <span>{t("overview.stat.active")}</span>
                      <strong>{counts.active}</strong>
                    </div>
                    <div className="hero-stat">
                      <span>{t("overview.stat.done")}</span>
                      <strong>{counts.completed}</strong>
                    </div>
                    <div className="hero-stat">
                      <span>{t("overview.stat.intercept")}</span>
                      <strong
                        style={{ cursor: "pointer", fontSize: "14px" }}
                        className={settings.autoInterceptDownloads ? "ok" : "muted"}
                        onClick={() =>
                          void onUpdateSettings({
                            autoInterceptDownloads: !settings.autoInterceptDownloads,
                          })
                        }
                      >
                        {settings.autoInterceptDownloads
                          ? t("overview.interceptOn")
                          : t("overview.interceptOff")}
                      </strong>
                    </div>
                  </div>
                </div>

                <div className="card">
                  <div className="card-head">
                    <h2>{t("nav.active")}</h2>
                    <div className="spacer" />
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void pauseAllTasks().then(onRefresh)}
                    >
                      {t("overview.pauseAll")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void resumeAllTasks().then(onRefresh)}
                    >
                      {t("overview.resumeAll")}
                    </button>
                  </div>
                  <div>
                    {tasks.filter((item) => !isCompleted(item)).length === 0 ? (
                      <div style={{ padding: "28px", textAlign: "center" }} className="muted">
                        {t("empty.desc.active")}
                      </div>
                    ) : (
                      tasks
                        .filter((item) => !isCompleted(item))
                        .slice(0, 6)
                        .map((item) => renderTaskRow(item, false))
                    )}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <div className="card">
                  <div className="card-head">
                    <h2>{t("overview.recent")}</h2>
                  </div>
                  <div>
                    {tasks.filter(isCompleted).length === 0 ? (
                      <div style={{ padding: "24px", textAlign: "center" }} className="muted">
                        {t("empty.desc.completed")}
                      </div>
                    ) : (
                      tasks
                        .filter(isCompleted)
                        .slice(0, 6)
                        .map((item) => (
                          <div
                            key={item.id}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "10px",
                              padding: "10px 16px",
                              borderBottom: "1px solid var(--line-soft)",
                              fontSize: "12px",
                            }}
                          >
                            <span className="ok">✓</span>
                            <span
                              style={{
                                flex: 1,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={item.name}
                            >
                              {item.name}
                            </span>
                            <span className="mono muted">{formatBytes(item.total)}</span>
                            <button
                              type="button"
                              className="icon-btn"
                              style={{ width: "26px", height: "26px" }}
                              title={t("task.openFolder")}
                              onClick={() =>
                                void revealTaskFile(item).catch((err) =>
                                  window.alert(err instanceof Error ? err.message : String(err)),
                                )
                              }
                            >
                              <FolderIcon />
                            </button>
                          </div>
                        ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {(view === "all" || view === "active" || view === "completed") && (
            <div>
              <div className="toolbar">
                {(["all", "active", "completed"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`chip ${view === f ? "active" : ""}`}
                    onClick={() => setView(f)}
                  >
                    {t(`nav.${f}`)} ({counts[f]})
                  </button>
                ))}
                <div className="spacer" />
                <select
                  className="btn btn-sm"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as typeof sort)}
                >
                  <option value="recent">{t("sort.recent")}</option>
                  <option value="speed">{t("sort.speed")}</option>
                  <option value="name">{t("sort.name")}</option>
                </select>
              </div>

              {selectedIds.size > 0 && (
                <div className="bulkbar">
                  <span>{t("task.selected", { count: selectedIds.size })}</span>
                  <div className="spacer" />
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={async () => {
                      for (const id of selectedIds) {
                        await pauseTask(id).catch(() => {});
                      }
                      await onRefresh();
                    }}
                  >
                    {t("task.pause")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={async () => {
                      for (const id of selectedIds) {
                        await resumeTask(id).catch(() => {});
                      }
                      await onRefresh();
                    }}
                  >
                    {t("task.resume")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={async () => {
                      for (const id of selectedIds) {
                        await removeTask(id, false).catch(() => {});
                      }
                      setSelectedIds(new Set());
                      await onRefresh();
                    }}
                  >
                    {t("task.remove")}
                  </button>
                </div>
              )}

              {visibleTasks.length === 0 ? (
                <div className="card" style={{ padding: "48px 20px", textAlign: "center" }}>
                  <h3 style={{ margin: 0 }}>{t("empty.title")}</h3>
                  <p className="muted" style={{ fontSize: "12.5px" }}>
                    {t(`empty.desc.${view}`)}
                  </p>
                </div>
              ) : (
                <div className="task-list-card">
                  {visibleTasks.map((item) => renderTaskRow(item, true))}
                </div>
              )}
            </div>
          )}

          {view === "settings" && (
            <SettingsView
              settings={settings}
              info={info}
              onSave={onUpdateSettings}
            />
          )}
        </main>

        <footer className="statusbar">
          <span className="ok">● {t("status.ready")}</span>
          <span>
            {formattedTotalSpeed.full} · {counts.active} Active / {counts.completed} Completed
          </span>
          <span
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: "12px",
            }}
          >
            {settings.standaloneMode ? (
              <span className="muted">○ Tug Agent ({t("sidebar.helperDisabled")})</span>
            ) : (
              <span
                className={helperStatus?.available ? "ok" : "muted"}
                style={{ cursor: helperStatus?.available ? "default" : "pointer" }}
                onClick={() => {
                  if (!helperStatus?.available) void onWakeHelper();
                }}
              >
                {helperStatus?.available
                  ? `● Agent :${helperStatus.port}`
                  : `○ Tug Agent (${t("sidebar.helperStandby")})`}
              </span>
            )}
            <span>{settings.connectionsPerTask} Connections/Task · OPFS Storage</span>
          </span>
        </footer>
      </div>

      {addModalOpen && (
        <AddTaskModal
          initialUrl={addInitialUrl}
          initialTorrentFile={addInitialTorrentFile}
          defaultConnections={settings.connectionsPerTask}
          onClose={() => {
            setAddModalOpen(false);
            setAddInitialTorrentFile(null);
            setAddInitialUrl(null);
          }}
          onSubmit={async (input: AddTaskInput) => {
            await addTask(input);
            await onRefresh();
          }}
        />
      )}

      {detailsTask && (
        <TaskDetailsModal
          task={tasks.find((item) => item.id === detailsTask.id) ?? detailsTask}
          onClose={() => setDetailsTask(null)}
          onUpdated={() => void onRefresh()}
        />
      )}

      {removeTarget && (
        <div className="modal-backdrop" onClick={() => setRemoveTarget(null)}>
          <div
            className="modal"
            style={{ width: "min(440px, 92vw)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h2>{t("task.removeTitle")}</h2>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setRemoveTarget(null)}
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div style={{ fontWeight: 600, fontSize: "13px" }}>
                {removeTarget.name}
              </div>
              <label
                className="check-row"
                style={{ padding: 0, alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  style={{ margin: 0 }}
                  checked={deleteFilesCheck}
                  onChange={(e) => setDeleteFilesCheck(e.target.checked)}
                />
                <span>
                  <b>{t("task.deleteFiles")}</b>
                </span>
              </label>
            </div>
            <div className="modal-foot">
              <button
                type="button"
                className="btn"
                onClick={() => setRemoveTarget(null)}
              >
                {t("add.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={async () => {
                  const id = removeTarget.id;
                  setRemoveTarget(null);
                  await removeTask(id, deleteFilesCheck);
                  await onRefresh();
                }}
              >
                {t("task.confirmRemove")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ManagerApp({ initialView = "overview" }: { initialView?: NavView }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [helperStatus, setHelperStatus] = useState<NativeHelperStatus | null>(null);
  const [wakingHelper, setWakingHelper] = useState(false);
  const [agentInstallOpen, setAgentInstallOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const snap = await getStateSnapshot();
      setInfo(snap.info);
      setSettings(snap.settings);
      setSettingsLoaded(true);
      setTasks(snap.tasks);
    } catch {
      // ignore initial race
    }
  }, []);

  const refreshHelper = useCallback(async () => {
    if (settings.standaloneMode) {
      setHelperStatus({ available: false, standaloneMode: true });
      return;
    }
    try {
      const st = await getNativeHelperStatus();
      setHelperStatus(st);
    } catch {
      // ignore
    }
  }, [settings.standaloneMode]);

  const probeHelperOnOpen = useCallback(async () => {
    if (settings.standaloneMode) return;
    setWakingHelper(true);
    try {
      const st = await ensureNativeHelper(false);
      setHelperStatus(st);
    } catch {
      // ignore
    } finally {
      setWakingHelper(false);
    }
  }, [settings.standaloneMode]);

  const handleWakeHelper = useCallback(async () => {
    if (settings.standaloneMode) return;
    setAgentInstallOpen(true);
  }, [settings.standaloneMode]);

  useEffect(() => {
    void refresh();
    const unsubscribe = subscribeTaskEvents((event) => {
      if (event.type === "settings") {
        setSettings(event.settings);
        setSettingsLoaded(true);
        return;
      }
      if (event.type === "removed") {
        setTasks((prev) => prev.filter((t) => t.id !== event.id));
        return;
      }
      if (event.type === "updated") {
        setTasks((prev) => {
          const exists = prev.some((t) => t.id === event.task.id);
          return exists
            ? prev.map((t) => (t.id === event.task.id ? event.task : t))
            : [event.task, ...prev];
        });
      }
    });
    return unsubscribe;
  }, [refresh]);

  useEffect(() => {
    if (!settingsLoaded) return;
    if (settings.standaloneMode) {
      setHelperStatus({ available: false, standaloneMode: true });
      return;
    }
    void probeHelperOnOpen();
    const timer = window.setInterval(() => {
      void refreshHelper();
    }, 6000);
    return () => {
      window.clearInterval(timer);
    };
  }, [settingsLoaded, settings.standaloneMode, probeHelperOnOpen, refreshHelper]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const dark =
        settings.theme === "dark" ||
        (settings.theme === "system" && mq.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    applyTheme();
    mq.addEventListener("change", applyTheme);
    return () => mq.removeEventListener("change", applyTheme);
  }, [settings.theme]);

  const handleUpdateSettings = async (patch: Partial<Settings>) => {
    const updated = await updateSettings(patch);
    setSettings(updated);
  };

  return (
    <I18nProvider localeSetting={settings.locale}>
      <ManagerInner
        initialView={initialView}
        settings={settings}
        info={info}
        tasks={tasks}
        helperStatus={helperStatus}
        wakingHelper={wakingHelper}
        onWakeHelper={handleWakeHelper}
        onRefresh={refresh}
        onUpdateSettings={handleUpdateSettings}
      />
      <AgentInstallModal
        open={agentInstallOpen}
        onClose={() => setAgentInstallOpen(false)}
        onActivated={refreshHelper}
      />
    </I18nProvider>
  );
}
