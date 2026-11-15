import { useEffect, useRef, useState } from "react";
import {
  activateNativeHelperProtocol,
  exportDownloadedAgent,
  ensureNativeHelper,
  getAgentInstallState,
  installNativeAgent,
  launchDownloadedAgent,
  resetAgentInstallState,
} from "../client";
import { formatBytes } from "../format";
import { useI18n } from "../i18n";
import type { AgentInstallState } from "../protocol";

export function AgentInstallModal({ open, compact = false, onClose, onActivated }: {
  open: boolean;
  compact?: boolean;
  onClose: () => void;
  onActivated: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<AgentInstallState>({ phase: "checking", bytesReceived: 0, totalBytes: 0, downloadId: null });
  const [busy, setBusy] = useState(false);
  const [needsAuthorization, setNeedsAuthorization] = useState(false);
  const actionActive = useRef(false);
  const actionFailed = useRef(false);
  const visible = useRef(open);
  const activated = useRef(false);
  const onActivatedRef = useRef(onActivated);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onActivatedRef.current = onActivated; onCloseRef.current = onClose; }, [onActivated, onClose]);
  const completeActivation = async () => {
    if (activated.current || !visible.current) return;
    activated.current = true;
    try { await onActivatedRef.current(); }
    finally { onCloseRef.current(); }
  };

  useEffect(() => {
    visible.current = open;
    if (!open) return;
    let cancelled = false;
    let timer: number | undefined;
    activated.current = false;
    actionFailed.current = false;
    setNeedsAuthorization(false);
    let lastProbe = 0;
    const poll = async (initial = false) => {
      try {
        let next = await getAgentInstallState();
        if (cancelled) return;
        if (initial && next.phase === "idle") next = await installNativeAgent();
        if (cancelled) return;
        if (next.phase === "need_pairing" && !actionActive.current && Date.now() - lastProbe >= 2000) {
          lastProbe = Date.now();
          const status = await ensureNativeHelper(false);
          if (cancelled) return;
          if (status.available) next = { ...next, phase: "ready" };
        }
        if (!actionActive.current && !actionFailed.current) setState(next);
        if (next.phase === "ready" && !activated.current) {
          await completeActivation();
        }
      } catch (err) {
        if (!cancelled && !actionActive.current) setState(prev => ({ ...prev, phase: "error", message: String(err) }));
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 400);
    };
    void poll(true);
    return () => { cancelled = true; visible.current = false; if (timer !== undefined) clearTimeout(timer); };
  }, [open]);

  const run = async (action: () => Promise<AgentInstallState>) => {
    if (actionActive.current) return;
    actionActive.current = true;
    actionFailed.current = false;
    setBusy(true);
    try {
      const next = await action();
      if (visible.current) setState(next);
      if (next.phase === "ready" && !activated.current && visible.current) {
        await completeActivation();
      }
    } catch (err) {
      actionFailed.current = true;
      if (visible.current) setState(prev => ({ ...prev, phase: "error", message: err instanceof Error ? err.message : String(err) }));
    } finally {
      actionActive.current = false;
      if (visible.current) setBusy(false);
    }
  };
  if (!open) return null;
  const pct = state.totalBytes > 0 ? Math.min(100, Math.round(state.bytesReceived / state.totalBytes * 100))
    : ["confirming_save", "launching", "waiting_ready", "need_manual_launch", "need_pairing", "ready"].includes(state.phase) ? 100 : 0;
  const handleConfirmSave = () => run(exportDownloadedAgent);
  const handleManualLaunch = () => run(async () => {
    const id = state.downloadId;
    if (id === null) throw new Error(t("agentInstall.fileMissing"));
    // Invoke while the click's user gesture is still active, before any await.
    try { await chrome.downloads.open(id); }
    catch { await resetAgentInstallState().catch(() => {}); throw new Error(t("agentInstall.launchFailed")); }
    if (visible.current) setState(prev => ({ ...prev, phase: "launching" }));
    return launchDownloadedAgent(id);
  });
  const handlePair = () => run(async () => {
    if (!needsAuthorization) {
      const status = await ensureNativeHelper(false);
      if (status.available) return { ...state, phase: "ready", message: undefined };
      if (status.updateRequired) throw new Error(t("agentInstall.updateRequired"));
      setNeedsAuthorization(true);
      return { ...state, phase: "need_pairing" };
    }
    // The fallback is a separate user gesture, only for unregistered browser IDs.
    const tab = await chrome.tabs.create({ url: `tug-agent://register?extId=${chrome.runtime.id}`, active: true });
    const status = await activateNativeHelperProtocol(tab.id);
    if (!status.available) throw new Error(t(status.updateRequired ? "agentInstall.updateRequired" : "agentInstall.pairFailed"));
    return { ...state, phase: "ready", message: undefined };
  });
  const handleRetry = () => run(installNativeAgent);
  const handleClose = () => {
    if (state.phase === "ready") void resetAgentInstallState().catch(() => {});
    onClose();
  };

  return (
    <div
      className="modal-backdrop"
      style={compact ? { padding: "12px" } : undefined}
      onClick={handleClose}
    >
      <div
        className="modal"
        style={
          compact
            ? { width: "calc(100vw - 24px)" }
            : { width: "min(460px, calc(100vw - 40px))" }
        }
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="modal-head"
          style={compact ? { padding: "10px 14px" } : undefined}
        >
          <h3 style={{ margin: 0, fontSize: compact ? "14px" : "16px" }}>
            {t("agentInstall.title")}
          </h3>
          <button
            type="button"
            className="icon-btn"
            style={compact ? { width: "24px", height: "24px" } : undefined}
            onClick={handleClose}
          >
            ×
          </button>
        </div>

        <div
          className="modal-body"
          style={compact ? { padding: "14px", gap: "10px" } : undefined}
        >
          <div style={{ fontSize: "12.5px", fontWeight: 600, lineHeight: 1.5 }}>
            {state.phase === "checking" && t("agentInstall.checking")}
            {state.phase === "downloading" && t("agentInstall.downloading")}
            {state.phase === "confirming_save" && (
              <span style={{ color: "var(--accent)" }}>
                {t("agentInstall.confirmingSave")}
              </span>
            )}
            {(state.phase === "launching" || state.phase === "waiting_ready") &&
              t("agentInstall.launching")}
            {state.phase === "need_manual_launch" && t("agentInstall.needManual")}
            {state.phase === "need_pairing" && t(needsAuthorization ? "agentInstall.needAuthorization" : "agentInstall.needPairing")}
            {state.phase === "ready" && (
              <span className="ok">● {t("agentInstall.ready")}</span>
            )}
            {state.phase === "error" && (
              <span style={{ color: "var(--red)" }}>
                {t("agentInstall.error", { msg: state.message || "Unknown" })}
              </span>
            )}
          </div>

          <div
            style={{
              height: "8px",
              borderRadius: "99px",
              background: "var(--surface-2)",
              border: "1px solid var(--line)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                background:
                  state.phase === "error"
                    ? "var(--red)"
                    : state.phase === "ready"
                      ? "var(--ok, #1f8f4e)"
                      : "var(--accent)",
                transition: "width 160ms ease",
              }}
            />
          </div>

          <div
            className="mono muted"
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "11px",
            }}
          >
            <span>
              {state.totalBytes > 0
                ? `${formatBytes(state.bytesReceived)} / ${formatBytes(state.totalBytes)}`
                : state.bytesReceived > 0
                  ? formatBytes(state.bytesReceived)
                  : "Tug Agent"}
            </span>
            <span>{pct}%</span>
          </div>
        </div>

        <div
          className="modal-foot"
          style={compact ? { padding: "9px 14px" } : undefined}
        >
          {state.phase === "confirming_save" && state.downloadId === null && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => void handleConfirmSave()}
            >
              {t("agentInstall.confirmSaveBtn")}
            </button>
          )}
          {state.phase === "need_manual_launch" && state.downloadId !== null && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => void handleManualLaunch()}
            >
              {t("agentInstall.manualBtn")}
            </button>
          )}
          {state.phase === "need_pairing" && (
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void handlePair()}>{t(needsAuthorization ? "agentInstall.authorizeBtn" : "agentInstall.pairBtn")}</button>
          )}
          {state.phase === "error" && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => void handleRetry()}
            >
              {t("agentInstall.retry")}
            </button>
          )}
          <button
            type="button"
            className={`btn btn-sm ${state.phase === "ready" ? "btn-primary" : ""}`}
            onClick={handleClose}
          >
            {state.phase === "ready" ? t("agentInstall.done") : t("add.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
