import { useEffect, useState } from "react";
import {
  exportDownloadedAgent,
  getAgentInstallState,
  installNativeAgent,
  launchDownloadedAgent,
  resetAgentInstallState,
} from "../client";
import { formatBytes } from "../format";
import { useI18n } from "../i18n";
import type { AgentInstallState } from "../protocol";

export function AgentInstallModal({
  open,
  compact = false,
  onClose,
  onActivated,
}: {
  open: boolean;
  compact?: boolean;
  onClose: () => void;
  onActivated: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<AgentInstallState>({
    phase: "checking",
    bytesReceived: 0,
    totalBytes: 0,
    downloadId: null,
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const next = await getAgentInstallState();
        if (cancelled) return;
        setState(next);
        if (next.phase === "ready") {
          void onActivated();
          return;
        }
        if (
          next.phase === "error" ||
          next.phase === "need_manual_launch" ||
          (next.phase === "confirming_save" && next.downloadId === null)
        ) {
          return;
        }
      } catch {
        // ignore transient poll error
      }
      if (!cancelled) {
        timer = window.setTimeout(() => void poll(), 200);
      }
    };

    void (async () => {
      try {
        const existing = await getAgentInstallState();
        if (cancelled) return;
        const activePhases = new Set([
          "downloading",
          "confirming_save",
          "launching",
          "waiting_ready",
          "need_manual_launch",
        ]);
        const initial = activePhases.has(existing.phase)
          ? existing
          : await installNativeAgent();
        if (cancelled) return;
        setState(initial);
        if (initial.phase === "ready") {
          void onActivated();
          return;
        }
        if (
          initial.phase !== "error" &&
          initial.phase !== "need_manual_launch" &&
          !(initial.phase === "confirming_save" && initial.downloadId === null)
        ) {
          timer = window.setTimeout(() => void poll(), 200);
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            phase: "error",
            bytesReceived: 0,
            totalBytes: 0,
            downloadId: null,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [open, onActivated]);

  if (!open) return null;

  const pct =
    state.totalBytes > 0
      ? Math.min(100, Math.round((state.bytesReceived / state.totalBytes) * 100))
      : state.phase === "confirming_save" ||
          state.phase === "launching" ||
          state.phase === "waiting_ready" ||
          state.phase === "need_manual_launch" ||
          state.phase === "ready"
        ? 100
        : 0;

  const handleConfirmSave = async () => {
    const next = await exportDownloadedAgent();
    setState(next);
    if (next.phase !== "error") {
      // 开始轮询直到浏览器保存完成进入 need_manual_launch
      const pollAfterSave = async () => {
        const cur = await getAgentInstallState().catch(() => null);
        if (!cur) return;
        setState(cur);
        if (cur.phase === "need_manual_launch" || cur.phase === "error" || cur.phase === "ready") {
          return;
        }
        window.setTimeout(() => void pollAfterSave(), 200);
      };
      window.setTimeout(() => void pollAfterSave(), 200);
    }
  };

  const handleManualLaunch = async () => {
    const id = state.downloadId;
    if (id === null) {
      await resetAgentInstallState().catch(() => {});
      setState({
        phase: "error",
        bytesReceived: 0,
        totalBytes: 0,
        downloadId: null,
        message: t("agentInstall.fileMissing"),
      });
      return;
    }

    // 校验文件是否仍然存在于磁盘，防止下载后被删除导致点击死循环
    try {
      const items = await chrome.downloads.search({ id });
      const item = items[0];
      if (!item || item.exists === false || item.state !== "complete") {
        await resetAgentInstallState().catch(() => {});
        setState({
          phase: "error",
          bytesReceived: 0,
          totalBytes: 0,
          downloadId: null,
          message: t("agentInstall.fileMissing"),
        });
        return;
      }
      await chrome.downloads.open(id);
    } catch {
      await resetAgentInstallState().catch(() => {});
      setState({
        phase: "error",
        bytesReceived: 0,
        totalBytes: 0,
        downloadId: null,
        message: t("agentInstall.launchFailed"),
      });
      return;
    }

    setState((prev) => ({ ...prev, phase: "launching" }));
    const next = await launchDownloadedAgent(id);
    setState(next);
    if (next.phase === "ready") {
      await onActivated();
    }
  };

  const handleRetry = async () => {
    setState({
      phase: "checking",
      bytesReceived: 0,
      totalBytes: 0,
      downloadId: null,
    });
    const next = await installNativeAgent();
    setState(next);
    if (next.phase === "ready") {
      await onActivated();
    } else if (next.phase !== "error") {
      const pollRetry = async () => {
        const cur = await getAgentInstallState().catch(() => null);
        if (!cur) return;
        setState(cur);
        if (
          cur.phase === "ready" ||
          cur.phase === "error" ||
          cur.phase === "need_manual_launch" ||
          (cur.phase === "confirming_save" && cur.downloadId === null)
        ) {
          if (cur.phase === "ready") void onActivated();
          return;
        }
        window.setTimeout(() => void pollRetry(), 200);
      };
      window.setTimeout(() => void pollRetry(), 200);
    }
  };

  const handleClose = () => {
    if (state.phase === "error" || state.phase === "ready") {
      void resetAgentInstallState().catch(() => {});
    }
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
              onClick={() => void handleConfirmSave()}
            >
              {t("agentInstall.confirmSaveBtn")}
            </button>
          )}
          {state.phase === "need_manual_launch" && state.downloadId !== null && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => void handleManualLaunch()}
            >
              {t("agentInstall.manualBtn")}
            </button>
          )}
          {state.phase === "error" && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
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
