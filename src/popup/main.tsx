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
  PlusIcon,
  PlayIcon,
  TrashIcon,
} from "../shared/icons";
import { I18nProvider, useI18n } from "../shared/i18n";
import "../shared/styles.css";
import {
  DEFAULT_SETTINGS,
  isActiveTaskState,
  canOpenTaskFile,
  type Settings,
  type TaskView,
} from "../shared/types";

function PopupInner({
  settings,
  tasks,
  helperStatus,
  checkingHelper,
  loading,
  loadError,
  onEnableAgent,
  onRefreshHelper,
  onRefresh,
  onToggleIntercept,
}: {
  settings: Settings;
  tasks: TaskView[];
  helperStatus: NativeHelperStatus | null;
  checkingHelper: boolean;
  loading: boolean;
  loadError: string | null;
  onEnableAgent: () => Promise<void>;
  onRefreshHelper: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onToggleIntercept: (enabled: boolean) => Promise<void>;
}) {
  const { t } = useI18n();
  const [urlInput, setUrlInput] = useState("");
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [agentInstallOpen, setAgentInstallOpen] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (settings.standaloneMode) { setAgentInstallOpen(false); return; }
    let cancelled = false;
    void getAgentInstallState()
      .then((st) => {
        if (cancelled) return;
        if (
          st.phase === "downloading" ||
          st.phase === "confirming_save" ||
          st.phase === "launching" ||
          st.phase === "waiting_ready" ||
          st.phase === "need_manual_launch" ||
          st.phase === "need_pairing"
        ) {
          setAgentInstallOpen(true);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [loading, settings.standaloneMode]);
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
    () => tasks.reduce((acc, item) => acc + (isActiveTaskState(item.state) ? item.speedBps || 0 : 0), 0),
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

  const agentChecking = !settings.standaloneMode && (loading || checkingHelper || !helperStatus);
  const agentLabel = settings.standaloneMode ? t("popup.browserMode")
    : agentChecking ? t("sidebar.helperConnecting")
      : helperStatus?.available ? t("popup.agentConnected")
        : t(helperStatus?.updateRequired ? "sidebar.helperUpdateRequired" : "sidebar.helperStandby");
  const runAction = async (action: () => Promise<unknown>) => {
    setError(null);
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const submit = async () => {
    if (addingRef.current || !urlInput.trim()) return;
    addingRef.current = true;
    setAdding(true);
    try { await runAction(handleQuickSubmit); }
    finally { addingRef.current = false; setAdding(false); }
  };
  const visibleTasks = [...tasks].sort((a, b) => Number(isActiveTaskState(b.state)) - Number(isActiveTaskState(a.state)));

  return (
    <div className="popup-shell">
      <header className="popup-head">
        <div className="popup-brand">
          <img src="/icons/icon-128.png" alt="" width="34" height="34" />
          <div className="popup-brand-copy">
            <strong>{t("app.name")}</strong>
            <button type="button"
              className={`popup-agent ${helperStatus?.available && !settings.standaloneMode ? "connected" : ""}`}
              disabled={loading || agentChecking || (!settings.standaloneMode && !!helperStatus?.available)}
              title={settings.standaloneMode ? t("sidebar.enableAgentHint") : agentLabel}
              onClick={() => settings.standaloneMode ? void runAction(onEnableAgent) : setAgentInstallOpen(true)}>
              <span className="popup-agent-dot" aria-hidden="true" />
              <span>{agentLabel}</span>
            </button>
          </div>
        </div>
        <div className="popup-speed" aria-label={`${t("popup.totalSpeed")}: ${speedFormatted.full}`}>
          <span>{t("popup.totalSpeed")}</span>
          <strong><span aria-hidden="true">↓ </span>{speedFormatted.full}</strong>
        </div>
      </header>

      <section className="popup-compose" aria-label={t("popup.newDownload")}>
        <form className="popup-quick" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <input type="text" disabled={adding} value={urlInput} onChange={(e) => setUrlInput(e.target.value)}
            aria-label={t("popup.urlPlaceholder")} placeholder={t("popup.urlPlaceholder")}
            spellCheck={false} autoComplete="off" />
          <button type="submit" className="btn btn-primary" disabled={loading || adding || !urlInput.trim()}>
            <PlusIcon />{t(adding ? "popup.adding" : "popup.quickAdd")}
          </button>
        </form>
        <div className="popup-compose-options">
          <label className="popup-intercept">
            <input type="checkbox" checked={settings.autoInterceptDownloads} disabled={loading}
              onChange={(e) => void runAction(() => onToggleIntercept(e.target.checked))} />
            <span>{t("popup.autoTakeover")}</span>
          </label>
          <input ref={fileRef} type="file" accept=".torrent,application/x-bittorrent" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ""; if (f) void handlePickTorrent(f); }} />
          <button type="button" className="popup-text-button" disabled={loading}
            onClick={() => fileRef.current?.click()} title={t("add.pickTorrent")}>
            {t("popup.importTorrent")}
          </button>
        </div>
      </section>

      {error && <div className="popup-error" role="alert">{error}</div>}

      <div className="popup-list-heading">
        <h2>{t("popup.downloads")}</h2>
        <div className="popup-bulk-actions">
          <button type="button" className="popup-text-button" disabled={!tasks.some(task => isActiveTaskState(task.state))}
            onClick={() => void runAction(async () => { await pauseAllTasks(); await onRefresh(); })}>
            <PauseIcon />{t("overview.pauseAll")}
          </button>
          <button type="button" className="popup-text-button" disabled={!tasks.some(task => task.state === "paused" || task.state === "failed")}
            onClick={() => void runAction(async () => { await resumeAllTasks(); await onRefresh(); })}>
            <PlayIcon />{t("overview.resumeAll")}
          </button>
        </div>
      </div>
      <div className="popup-list" aria-busy={loading}>
        {loading ? (
          <div className="popup-loading" role="status">{loadError ? <><p>{t("popup.loadFailed")}</p><button type="button" className="btn btn-sm" onClick={() => void onRefresh()}>{t("popup.retry")}</button></> : t("popup.loading")}</div>
        ) : tasks.length === 0 ? (
          <div className="popup-empty">
            <div className="popup-empty-mark" aria-hidden="true">↓</div>
            <strong>{t("popup.emptyTitle")}</strong>
            <p>{t("popup.empty")}</p>
          </div>
        ) : visibleTasks.map((task) => {
          const pct = calcProgressPercent(task.downloaded, task.total);
          const done = task.state === "completed" || task.state === "seeding";
          const active = isActiveTaskState(task.state);
          return (
            <article key={task.id} className="popup-task">
              <div className="popup-task-top">
                <span className={`type-tag ${task.kind === "torrent" ? "bt" : "http"}`}>{task.kind === "torrent" ? "BT" : "HTTP"}</span>
                <span className="popup-task-name" title={task.name}>{task.name}</span>
              </div>
              <div className="popup-task-progress">
                <span className={`state-tag ${task.state}`}>{t(`task.state.${task.state}`)}</span>
                <span>{task.total === null ? "—" : `${pct.toFixed(0)}%`}</span>
              </div>
              <SegmentBar task={task} />
              <div className="popup-task-bottom">
                <div className="popup-task-details">
                  <span>{formatBytes(task.downloaded)} / {formatBytes(task.total)}</span>
                  {active && <span className="popup-task-speed">{formatSpeed(task.speedBps).full}{task.etaSecs !== null && <> · {t("popup.remaining", { time: formatEta(task.etaSecs) })}</>}</span>}
                </div>
                <div className="popup-task-actions">
                  {!done ? (
                    <button type="button" className="icon-btn" title={t(active ? "task.pause" : "task.resume")}
                      aria-label={t(active ? "task.pause" : "task.resume")}
                      onClick={() => void runAction(async () => { if (active) await pauseTask(task.id); else await resumeTask(task.id); await onRefresh(); })}>
                      {active ? <PauseIcon /> : <PlayIcon />}
                    </button>
                  ) : (<>
                    {canOpenTaskFile(task) && <button type="button" className="icon-btn" title={t("task.open")} aria-label={t("task.open")}
                      onClick={() => void runAction(() => openTaskFile(task))}><ExternalIcon /></button>}
                    <button type="button" className="icon-btn" title={t("task.openFolder")} aria-label={t("task.openFolder")}
                      onClick={() => void runAction(() => revealTaskFile(task))}><FolderIcon /></button>
                  </>)}
                  <button type="button" className="icon-btn danger" title={t("task.removeTitle")} aria-label={t("task.removeTitle")}
                    onClick={() => { setDeleteFilesCheck(false); setRemoveTarget(task); }}><TrashIcon /></button>
                </div>
              </div>
              {task.error && <p className="popup-task-error" title={task.error}>{task.error}</p>}
            </article>
          );
        })}
      </div>
      <footer className="popup-foot">
        <button type="button" className="btn btn-sm" onClick={() => void runAction(() => openDownloadsFolder(settings.standaloneMode))}>
          <FolderIcon /><span>{t("toolbar.openFolder")}</span>
        </button>
        <button type="button" className="btn btn-sm popup-manager" onClick={() => void runAction(() => openManagerTab())}>
          <span>{t("popup.openManager")}</span><ExternalIcon />
        </button>
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
        open={agentInstallOpen && !loading && !settings.standaloneMode}
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [helperStatus, setHelperStatus] = useState<NativeHelperStatus | null>(null);
  const [checkingHelper, setCheckingHelper] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setLoadError(null);
      const snap = await getStateSnapshot();
      setSettings(snap.settings);
      setSettingsLoaded(true);
      setTasks(snap.tasks);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
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
      setHelperStatus({ available: false });
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
        loading={!settingsLoaded}
        loadError={loadError}
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
