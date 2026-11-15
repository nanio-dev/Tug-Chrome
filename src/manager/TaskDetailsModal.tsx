import { useEffect, useState } from "react";
import {
  getTorrentRuntime,
  listTorrentFiles,
  setTorrentFiles,
} from "../shared/client";
import { SegmentBar } from "../shared/components/SegmentBar";
import { calcProgressPercent, formatBytes } from "../shared/format";
import { useI18n } from "../shared/i18n";
import type {
  TaskView,
  TorrentFileInfo,
  TorrentRuntimeDetails,
} from "../shared/types";

export function TaskDetailsModal({
  task,
  onClose,
  onUpdated,
}: {
  task: TaskView;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"segments" | "files" | "peers">(
    task.kind === "torrent" ? "files" : "segments",
  );
  const [files, setFiles] = useState<TorrentFileInfo[]>([]);
  const [selectedSet, setSelectedSet] = useState<Set<number>>(new Set());
  const [runtime, setRuntime] = useState<TorrentRuntimeDetails | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (task.kind !== "torrent") return;
    let active = true;
    const load = async () => {
      try {
        const [fList, rt] = await Promise.all([
          listTorrentFiles(task.id),
          getTorrentRuntime(task.id),
        ]);
        if (!active) return;
        setFiles(fList);
        setSelectedSet(new Set(fList.filter((f) => f.selected).map((f) => f.index)));
        setRuntime(rt);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = window.setInterval(() => {
      getTorrentRuntime(task.id)
        .then((rt) => {
          if (active) setRuntime(rt);
        })
        .catch(() => {});
    }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [task.id, task.kind]);

  const handleSaveFiles = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await setTorrentFiles(task.id, Array.from(selectedSet));
      setFiles(updated);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: "min(760px, 95vw)" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span className={`type-tag ${task.kind === "torrent" ? "bt" : "http"}`}>
                {task.kind === "torrent" ? "BT" : "HTTP"}
              </span>
              <span className={`state-tag ${task.state}`}>
                {t(`task.state.${task.state}`)}
              </span>
              {task.infoHash && (
                <span className="mono muted" style={{ fontSize: "10.5px" }}>
                  #{task.infoHash.slice(0, 16)}…
                </span>
              )}
            </div>
            <h2 style={{ marginTop: "6px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {task.name}
            </h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <SegmentBar task={task} />

          <div
            style={{
              display: "flex",
              gap: "8px",
              borderBottom: "1px solid var(--line)",
              paddingBottom: "8px",
            }}
          >
            <button
              type="button"
              className={`chip ${tab === "segments" ? "active" : ""}`}
              onClick={() => setTab("segments")}
            >
              {t("task.segments")} ({task.segments.length})
            </button>
            {task.kind === "torrent" && (
              <>
                <button
                  type="button"
                  className={`chip ${tab === "files" ? "active" : ""}`}
                  onClick={() => setTab("files")}
                >
                  {t("bt.files")} ({files.length})
                </button>
                <button
                  type="button"
                  className={`chip ${tab === "peers" ? "active" : ""}`}
                  onClick={() => setTab("peers")}
                >
                  {t("bt.peers")} & {t("bt.trackers")}
                </button>
              </>
            )}
          </div>

          {tab === "segments" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div className="hint">
                {task.rangeSupported ? t("task.rangeYes") : t("task.rangeNo")} · URL:{" "}
                <span className="mono">{task.url}</span>
              </div>
              <div
                style={{
                  maxHeight: "260px",
                  overflow: "auto",
                  border: "1px solid var(--line)",
                  borderRadius: "10px",
                }}
              >
                {task.segments.length === 0 ? (
                  <div style={{ padding: "16px", textAlign: "center" }} className="muted">
                    —
                  </div>
                ) : (
                  task.segments.map((seg) => {
                    const segTotal = Math.max(1, seg.end - seg.start);
                    const segDone = Math.max(0, seg.current - seg.start);
                    const pct = calcProgressPercent(segDone, segTotal);
                    return (
                      <div
                        key={`${seg.index}-${seg.start}`}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "60px 1fr 150px 70px",
                          gap: "10px",
                          alignItems: "center",
                          padding: "8px 12px",
                          borderBottom: "1px solid var(--line-soft)",
                          fontSize: "11.5px",
                        }}
                      >
                        <span className="mono">#{seg.index + 1}</span>
                        <div className={`progress ${seg.state === "completed" ? "done" : "http"}`}>
                          <i style={{ width: `${pct.toFixed(1)}%` }} />
                        </div>
                        <span className="mono muted" style={{ textAlign: "right" }}>
                          {formatBytes(segDone)} / {formatBytes(segTotal)}
                        </span>
                        <span className="mono" style={{ textAlign: "right" }}>
                          {pct.toFixed(0)}%
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {tab === "files" && task.kind === "torrent" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span className="hint">
                  {t("bt.selected", { selected: selectedSet.size, total: files.length })}
                </span>
                <div className="spacer" />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={task.state === "completed"}
                  onClick={() => setSelectedSet(new Set(files.map((f) => f.index)))}
                >
                  {t("bt.selectAll")}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={task.state === "completed"}
                  onClick={() => setSelectedSet(new Set())}
                >
                  {t("bt.clear")}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={saving || task.state === "completed" || selectedSet.size === 0}
                  onClick={() => void handleSaveFiles()}
                >
                  {t("bt.save")}
                </button>
              </div>

              <div
                style={{
                  maxHeight: "250px",
                  overflow: "auto",
                  border: "1px solid var(--line)",
                  borderRadius: "10px",
                }}
              >
                {files.map((file) => {
                  const checked = selectedSet.has(file.index);
                  return (
                    <label
                      key={file.index}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                        padding: "8px 12px",
                        borderBottom: "1px solid var(--line-soft)",
                        fontSize: "12px",
                        cursor: task.state === "completed" ? "default" : "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={task.state === "completed"}
                        onChange={() => {
                          setSelectedSet((prev) => {
                            const next = new Set(prev);
                            if (next.has(file.index)) next.delete(file.index);
                            else next.add(file.index);
                            return next;
                          });
                        }}
                      />
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                        {file.path}
                      </span>
                      <span className="mono muted">{formatBytes(file.length)}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {tab === "peers" && task.kind === "torrent" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <div>
                <b style={{ fontSize: "12px" }}>{t("bt.peers")}</b>
                <div
                  style={{
                    marginTop: "6px",
                    maxHeight: "130px",
                    overflow: "auto",
                    border: "1px solid var(--line)",
                    borderRadius: "10px",
                  }}
                >
                  {!runtime || runtime.peers.length === 0 ? (
                    <div style={{ padding: "12px" }} className="hint">
                      {t("bt.noPeers")}
                    </div>
                  ) : (
                    runtime.peers.map((peer) => (
                      <div
                        key={peer.address}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          padding: "7px 12px",
                          borderBottom: "1px solid var(--line-soft)",
                          fontSize: "11.5px",
                        }}
                      >
                        <span className="mono">{peer.address}</span>
                        <span className="mono muted">
                          {peer.client ?? peer.transport} · {formatBytes(peer.downloaded)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div>
                <b style={{ fontSize: "12px" }}>{t("bt.trackers")}</b>
                <div
                  style={{
                    marginTop: "6px",
                    maxHeight: "130px",
                    overflow: "auto",
                    border: "1px solid var(--line)",
                    borderRadius: "10px",
                  }}
                >
                  {!runtime ||
                  (runtime.trackers.length === 0 && runtime.webSeeds.length === 0) ? (
                    <div style={{ padding: "12px" }} className="hint">
                      {t("bt.noTrackers")}
                    </div>
                  ) : (
                    <>
                      {runtime.webSeeds.map((ws) => (
                        <div
                          key={`ws-${ws}`}
                          style={{
                            padding: "6px 12px",
                            borderBottom: "1px solid var(--line-soft)",
                            fontSize: "11px",
                          }}
                          className="mono ok"
                        >
                          [WebSeed] {ws}
                        </div>
                      ))}
                      {runtime.trackers.map((tr) => (
                        <div
                          key={`tr-${tr}`}
                          style={{
                            padding: "6px 12px",
                            borderBottom: "1px solid var(--line-soft)",
                            fontSize: "11px",
                          }}
                          className="mono muted"
                        >
                          [Tracker] {tr}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {error && (
            <div style={{ color: "var(--red)", fontSize: "12px" }}>{error}</div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            {t("bt.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
