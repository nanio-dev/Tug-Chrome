import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  parseTorrentBuffer,
  uint8ArrayToBase64,
  type ParsedTorrent,
} from "../engine/torrent/parser";
import {
  addTask,
  ensureNativeHelper,
  getAgentInstallState,
  getNativeHelperStatus,
  getStateSnapshot,
  openDownloadsFolder,
  openManagerTab,
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
  PauseIcon,
  PlayIcon,
  TrashIcon,
} from "../shared/icons";
import { I18nProvider, useI18n } from "../shared/i18n";
import "../shared/styles.css";
import {
  DEFAULT_SETTINGS,
  type Settings,
  type TaskView,
} from "../shared/types";

function PopupInner({
  settings,
  tasks,
  helperStatus,
  checkingHelper,
  onEnableAgent,
  onRefreshHelper,
  onRefresh,
  onToggleIntercept,
}: {
  settings: Settings;
  tasks: TaskView[];
  helperStatus: NativeHelperStatus | null;
  checkingHelper: boolean;
  onEnableAgent: () => Promise<void>;
  onRefreshHelper: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onToggleIntercept: (enabled: boolean) => Promise<void>;
}) {
  const { t } = useI18n();
  const [urlInput, setUrlInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [agentInstallOpen, setAgentInstallOpen] = useState(false);

  useEffect(() => {
    void getAgentInstallState()
      .then((st) => {
        if (
          st.phase === "downloading" ||
          st.phase === "confirming_save" ||
          st.phase === "launching" ||
          st.phase === "waiting_ready" ||
          st.phase === "need_manual_launch"
        ) {
          setAgentInstallOpen(true);
        }
      })
      .catch(() => {});
  }, []);
  const [pendingTorrent, setPendingTorrent] = useState<{
    base64: string;
    fileName: string;
    meta: ParsedTorrent;
  } | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<number>>(new Set());
  const [submittingTorrent, setSubmittingTorrent] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<TaskView | null>(null);
  const [deleteFilesCheck, setDeleteFilesCheck] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const totalSpeed = useMemo(
    () => tasks.reduce((acc, item) => acc + (item.speedBps || 0), 0),
    [tasks],
  );
  const speedFormatted = formatSpeed(totalSpeed);

  const selectedTorrentBytes = useMemo(() => {
    if (!pendingTorrent) return 0;
    let sum = 0;
    for (const file of pendingTorrent.meta.files) {
      if (selectedFiles.has(file.index)) {
        sum += file.length;
      }
    }
    return sum;
  }, [pendingTorrent, selectedFiles]);

  const handleQuickSubmit = async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    setError(null);
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
          setUrlInput("");
          await onRefresh();
          return;
        }
      } catch {
        // 拉取/解析失败或包含多个文件时打开管理页让用户确认
      }
      setUrlInput("");
      await openManagerTab(trimmed);
      return;
    }
    try {
      await addTask({ url: trimmed });
      setUrlInput("");
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePickTorrent = async (file: File) => {
    setError(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const meta = await parseTorrentBuffer(buf);
      const base64 = uint8ArrayToBase64(buf);
      const fileName = file.name.replace(/\.torrent$/i, "") || meta.name;
      if (meta.files.length <= 1) {
        await addTask({
          url: "",
          fileName,
          torrentBytesBase64: base64,
        });
        await onRefresh();
        return;
      }
      setPendingTorrent({
        base64,
        fileName,
        meta,
      });
      setSelectedFiles(new Set(meta.files.map((f) => f.index)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConfirmPendingTorrent = async () => {
    if (!pendingTorrent) return;
    if (selectedFiles.size === 0) {
      setError(t("add.torrentNoSelection"));
      return;
    }
    setSubmittingTorrent(true);
    setError(null);
    try {
      await addTask({
        url: "",
        fileName: pendingTorrent.fileName,
        torrentBytesBase64: pendingTorrent.base64,
        onlyFiles: Array.from(selectedFiles).sort((a, b) => a - b),
      });
      setPendingTorrent(null);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingTorrent(false);
    }
  };

  return (
    <div className="popup-shell">
      <header className="popup-head">
        <div className="popup-brand">
          <img src="/icons/icon-128.png" alt="Tug Web" />
          <strong>{t("app.name")}</strong>
        </div>
        {settings.standaloneMode ? (
          <span
            className="muted"
            style={{
              fontSize: "11px",
              cursor: "pointer",
              textDecoration: "underline",
            }}
            title={t("sidebar.enableAgentHint")}
            onClick={() => void onEnableAgent()}
          >
            ○ Agent:{t("sidebar.helperDisabled")}
          </span>
        ) : (
          <span
            className={helperStatus?.available ? "ok" : "muted"}
            style={{
              fontSize: "11px",
              cursor: helperStatus?.available || checkingHelper ? "default" : "pointer",
              textDecoration: helperStatus?.available || checkingHelper ? "none" : "underline",
            }}
            title={t("sidebar.helperLabel")}
            onClick={() => {
              if (!helperStatus?.available && !checkingHelper) {
                setAgentInstallOpen(true);
              }
            }}
          >
            {helperStatus?.available
              ? `● Agent:${t("popup.agentEnabled")}`
              : checkingHelper
                ? `○ ${t("sidebar.helperConnecting")}`
                : `○ ${t("sidebar.helperStandby")}`}
          </span>
        )}
        <span className="popup-speed-pill">↓ {speedFormatted.full}</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void openManagerTab()}
        >
          {t("popup.openManager")}
        </button>
      </header>

      <div className="popup-quick">
        <input
          type="text"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleQuickSubmit();
          }}
          placeholder={t("add.urlPlaceholder")}
        />
        <input
          ref={fileRef}
          type="file"
          accept=".torrent,application/x-bittorrent"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.currentTarget.value = "";
            if (f) void handlePickTorrent(f);
          }}
        />
        <button
          type="button"
          className="btn btn-sm"
          title={t("add.pickTorrent")}
          onClick={() => fileRef.current?.click()}
        >
          .torrent
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => void handleQuickSubmit()}
        >
          {t("popup.quickAdd")}
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: "6px 14px",
            fontSize: "11px",
            background: "var(--red-soft)",
            color: "var(--red)",
          }}
        >
          {error}
        </div>
      )}

      <div className="popup-bar">
        <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={settings.autoInterceptDownloads}
            onChange={(e) => void onToggleIntercept(e.target.checked)}
            style={{ accentColor: "var(--accent)" }}
          />
          <span style={{ fontWeight: 600 }}>{t("popup.autoTakeover")}</span>
        </label>

        <div style={{ display: "flex", gap: "4px" }}>
          <button
            type="button"
            className="btn btn-sm"
            style={{ height: "24px", padding: "0 7px", fontSize: "10.5px" }}
            onClick={() => void pauseAllTasks().then(onRefresh)}
          >
            {t("overview.pauseAll")}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            style={{ height: "24px", padding: "0 7px", fontSize: "10.5px" }}
            onClick={() => void resumeAllTasks().then(onRefresh)}
          >
            {t("overview.resumeAll")}
          </button>
        </div>
      </div>

      <div className="popup-list">
        {tasks.length === 0 ? (
          <div style={{ padding: "54px 20px", textAlign: "center" }} className="muted">
            {t("popup.empty")}
          </div>
        ) : (
          tasks.slice(0, 8).map((task) => {
            const pct = calcProgressPercent(task.downloaded, task.total);
            const done = task.state === "completed" || task.state === "seeding";
            const active =
              task.state === "downloading" ||
              task.state === "fetching_metadata" ||
              task.state === "queued";
            const sp = formatSpeed(task.speedBps);

            return (
              <div key={task.id} className="popup-task">
                <div className="popup-task-top">
                  <span className={`type-tag ${task.kind === "torrent" ? "bt" : "http"}`}>
                    {task.kind === "torrent" ? "BT" : "HTTP"}
                  </span>
                  <span className="popup-task-name" title={task.name}>
                    {task.name}
                  </span>
                  <span className={`state-tag ${task.state}`}>
                    {t(`task.state.${task.state}`)}
                  </span>
                </div>

                <SegmentBar task={task} />

                <div className="popup-task-bottom">
                  <span>
                    {formatBytes(task.downloaded)} / {formatBytes(task.total)} ({pct.toFixed(0)}%)
                  </span>
                  <span>
                    {active
                      ? `${sp.full} · ETA ${formatEta(task.etaSecs)}`
                      : task.error
                        ? task.error.slice(0, 26)
                        : ""}
                  </span>
                  <div style={{ display: "flex", gap: "4px" }}>
                    {!done ? (
                      <button
                        type="button"
                        className="icon-btn"
                        style={{ width: "24px", height: "24px" }}
                        onClick={async () => {
                          if (active) await pauseTask(task.id);
                          else await resumeTask(task.id);
                          await onRefresh();
                        }}
                      >
                        {active ? <PauseIcon /> : <PlayIcon />}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="icon-btn"
                          style={{ width: "24px", height: "24px" }}
                          title={t("task.open")}
                          onClick={() =>
                            void openTaskFile(task).catch((err) =>
                              setError(err instanceof Error ? err.message : String(err)),
                            )
                          }
                        >
                          <ExternalIcon />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          style={{ width: "24px", height: "24px" }}
                          title={t("task.openFolder")}
                          onClick={() =>
                            void revealTaskFile(task).catch((err) =>
                              setError(err instanceof Error ? err.message : String(err)),
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
                      style={{ width: "24px", height: "24px" }}
                      title={t("task.removeTitle")}
                      onClick={() => {
                        setDeleteFilesCheck(false);
                        setRemoveTarget(task);
                      }}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <footer className="popup-foot">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void openDownloadsFolder(settings.standaloneMode)}
        >
          <FolderIcon />
          <span>{t("toolbar.openFolder")}</span>
        </button>
        <span className="muted" style={{ fontSize: "11px" }}>
          {t("popup.taskCount", { count: tasks.length })}
        </span>
      </footer>

      {pendingTorrent && (
        <div className="modal-backdrop" style={{ padding: "12px" }} onClick={() => setPendingTorrent(null)}>
          <div
            className="modal"
            style={{ width: "calc(100vw - 24px)", maxHeight: "calc(100vh - 24px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head" style={{ padding: "10px 14px" }}>
              <div style={{ minWidth: 0 }}>
                <h2 style={{ fontSize: "14px" }}>{t("add.torrentFilesTitle")}</h2>
                <div
                  className="hint"
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={pendingTorrent.meta.name}
                >
                  {pendingTorrent.meta.name}
                </div>
              </div>
              <button
                type="button"
                className="icon-btn"
                style={{ width: "26px", height: "26px" }}
                onClick={() => setPendingTorrent(null)}
              >
                ✕
              </button>
            </div>

            <div className="modal-body" style={{ padding: "10px 14px", gap: "8px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span className="hint" style={{ flex: 1 }}>
                  {t("add.torrentSummary", {
                    selected: selectedFiles.size,
                    total: pendingTorrent.meta.files.length,
                    size: formatBytes(selectedTorrentBytes),
                  })}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ height: "24px", padding: "0 7px", fontSize: "10.5px" }}
                  onClick={() =>
                    setSelectedFiles(new Set(pendingTorrent.meta.files.map((f) => f.index)))
                  }
                >
                  {t("bt.selectAll")}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ height: "24px", padding: "0 7px", fontSize: "10.5px" }}
                  onClick={() => setSelectedFiles(new Set())}
                >
                  {t("bt.clear")}
                </button>
              </div>

              <div
                style={{
                  maxHeight: "210px",
                  overflowY: "auto",
                  border: "1px solid var(--line)",
                  borderRadius: "9px",
                  background: "var(--surface-2)",
                }}
              >
                {pendingTorrent.meta.files.map((file) => {
                  const checked = selectedFiles.has(file.index);
                  return (
                    <label
                      key={file.index}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "7px 10px",
                        borderBottom: "1px solid var(--line-soft)",
                        fontSize: "11.5px",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setSelectedFiles((prev) => {
                            const next = new Set(prev);
                            if (next.has(file.index)) next.delete(file.index);
                            else next.add(file.index);
                            return next;
                          });
                        }}
                      />
                      <span
                        style={{
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={file.path}
                      >
                        {file.path}
                      </span>
                      <span className="mono muted" style={{ fontSize: "10.5px" }}>
                        {formatBytes(file.length)}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="modal-foot" style={{ padding: "9px 14px" }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setPendingTorrent(null)}
              >
                {t("add.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={submittingTorrent || selectedFiles.size === 0}
                onClick={() => void handleConfirmPendingTorrent()}
              >
                {submittingTorrent ? t("add.starting") : t("add.start")}
              </button>
            </div>
          </div>
        </div>
      )}

      {removeTarget && (
        <div
          className="modal-backdrop"
          style={{ padding: "12px" }}
          onClick={() => setRemoveTarget(null)}
        >
          <div
            className="modal"
            style={{ width: "calc(100vw - 24px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head" style={{ padding: "10px 14px" }}>
              <h3>{t("task.removeTitle")}</h3>
              <button
                type="button"
                className="icon-btn"
                style={{ width: "24px", height: "24px" }}
                onClick={() => setRemoveTarget(null)}
              >
                ×
              </button>
            </div>
            <div className="modal-body" style={{ padding: "14px", gap: "10px" }}>
              <p style={{ margin: 0, fontSize: "12.5px", wordBreak: "break-all" }}>
                <strong>{removeTarget.fileName}</strong>
              </p>
              <label
                className="check-row"
                style={{ fontSize: "12px", padding: 0, alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  style={{ margin: 0 }}
                  checked={deleteFilesCheck}
                  onChange={(e) => setDeleteFilesCheck(e.target.checked)}
                />
                <span>{t("task.deleteFiles")}</span>
              </label>
            </div>
            <div className="modal-foot" style={{ padding: "9px 14px" }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setRemoveTarget(null)}
              >
                {t("add.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={async () => {
                  const target = removeTarget;
                  setRemoveTarget(null);
                  await removeTask(target.id, deleteFilesCheck);
                  await onRefresh();
                }}
              >
                {t("task.confirmRemove")}
              </button>
            </div>
          </div>
        </div>
      )}

      <AgentInstallModal
        open={agentInstallOpen}
        compact
        onClose={() => setAgentInstallOpen(false)}
        onActivated={onRefreshHelper}
      />
    </div>
  );
}

function PopupApp() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [helperStatus, setHelperStatus] = useState<NativeHelperStatus | null>(null);
  const [checkingHelper, setCheckingHelper] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const snap = await getStateSnapshot();
      setSettings(snap.settings);
      setSettingsLoaded(true);
      setTasks(snap.tasks);
    } catch {
      // ignore
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
    setCheckingHelper(true);
    try {
      const st = await ensureNativeHelper(false);
      setHelperStatus(st);
    } catch {
      // ignore
    } finally {
      setCheckingHelper(false);
    }
  }, []);

  const handleEnableAgent = useCallback(async () => {
    const updated = await updateSettings({ standaloneMode: false });
    setSettings(updated);
    await probeHelperOnOpen();
  }, [probeHelperOnOpen]);

  useEffect(() => {
    void refresh();
    return subscribeTaskEvents((event) => {
      if (event.type === "settings") {
        setSettings(event.settings);
        setSettingsLoaded(true);
      } else if (event.type === "removed") {
        setTasks((prev) => prev.filter((t) => t.id !== event.id));
      } else if (event.type === "updated") {
        setTasks((prev) => {
          const exists = prev.some((t) => t.id === event.task.id);
          return exists
            ? prev.map((t) => (t.id === event.task.id ? event.task : t))
            : [event.task, ...prev];
        });
      }
    });
  }, [refresh]);

  useEffect(() => {
    if (!settingsLoaded) return;
    if (settings.standaloneMode) {
      setHelperStatus({ available: false, standaloneMode: true });
      return;
    }
    void probeHelperOnOpen();
  }, [settingsLoaded, settings.standaloneMode, probeHelperOnOpen]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const dark =
      settings.theme === "dark" ||
      (settings.theme === "system" && mq.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [settings.theme]);

  return (
    <I18nProvider localeSetting={settings.locale}>
      <PopupInner
        settings={settings}
        tasks={tasks}
        helperStatus={helperStatus}
        checkingHelper={checkingHelper}
        onEnableAgent={handleEnableAgent}
        onRefreshHelper={refreshHelper}
        onRefresh={refresh}
        onToggleIntercept={async (enabled) => {
          const updated = await updateSettings({ autoInterceptDownloads: enabled });
          setSettings(updated);
        }}
      />
    </I18nProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PopupApp />
  </StrictMode>,
);
