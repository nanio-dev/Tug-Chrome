import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  parseTorrentBuffer,
  uint8ArrayToBase64,
  type ParsedTorrent,
} from "../engine/torrent/parser";
import { formatBytes } from "../shared/format";
import { useI18n } from "../shared/i18n";
import type { AddTaskInput } from "../shared/types";

function isHttpTorrentUrl(rawUrl: string): boolean {
  return /^https?:\/\/.+\.torrent($|[?#])/i.test(rawUrl.trim());
}

export function AddTaskModal({
  initialUrl,
  initialTorrentFile,
  defaultConnections,
  onClose,
  onSubmit,
}: {
  initialUrl?: string | null;
  initialTorrentFile?: File | null;
  defaultConnections: number;
  onClose: () => void;
  onSubmit: (input: AddTaskInput) => Promise<void>;
}) {
  const { t } = useI18n();
  const [url, setUrl] = useState(initialUrl ?? "");
  const [fileName, setFileName] = useState("");
  const [connections, setConnections] = useState(defaultConnections);
  const [referrer, setReferrer] = useState("");
  const [checksum, setChecksum] = useState("");
  const [torrentBase64, setTorrentBase64] = useState<string | null>(null);
  const [torrentName, setTorrentName] = useState<string | null>(null);
  const [parsedTorrent, setParsedTorrent] = useState<ParsedTorrent | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<number>>(new Set());
  const [parsingTorrent, setParsingTorrent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const applyParsedTorrentBytes = async (buf: Uint8Array, displayName: string, autoFillUrl?: string) => {
    const meta = await parseTorrentBuffer(buf);
    setTorrentBase64(uint8ArrayToBase64(buf));
    setTorrentName(displayName);
    setParsedTorrent(meta);
    setSelectedFiles(new Set(meta.files.map((f) => f.index)));
    if (autoFillUrl !== undefined) {
      setUrl(autoFillUrl);
    }
    setError(null);
    return meta;
  };

  const handleTorrentFilePick = async (file: File) => {
    setParsingTorrent(true);
    setError(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const nextUrl = !url.trim() ? `torrent://${file.name}` : undefined;
      await applyParsedTorrentBytes(buf, file.name, nextUrl);
    } catch (err) {
      setTorrentBase64(null);
      setTorrentName(null);
      setParsedTorrent(null);
      setSelectedFiles(new Set());
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setParsingTorrent(false);
    }
  };

  const fetchAndParseTorrentUrl = async (targetUrl: string): Promise<ParsedTorrent | null> => {
    setParsingTorrent(true);
    setError(null);
    try {
      const resp = await fetch(targetUrl);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const buf = new Uint8Array(await resp.arrayBuffer());
      const meta = await applyParsedTorrentBytes(buf, targetUrl.split("/").pop()?.split("?")[0] || "torrent");
      return meta;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setParsingTorrent(false);
    }
  };

  useEffect(() => {
    if (initialTorrentFile) {
      void handleTorrentFilePick(initialTorrentFile);
      return;
    }
    if (initialUrl && isHttpTorrentUrl(initialUrl)) {
      void fetchAndParseTorrentUrl(initialUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTorrentFile, initialUrl]);

  const selectedBytes = useMemo(() => {
    if (!parsedTorrent) return 0;
    let sum = 0;
    for (const file of parsedTorrent.files) {
      if (selectedFiles.has(file.index)) {
        sum += file.length;
      }
    }
    return sum;
  }, [parsedTorrent, selectedFiles]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!torrentBase64 && !/^https?:\/\/|^magnet:\?/i.test(trimmed)) {
      setError(t("add.invalidUrl"));
      return;
    }

    if (!parsedTorrent && isHttpTorrentUrl(trimmed)) {
      // 用户手动粘贴 .torrent 链接后点击按钮，先拉取并展示文件勾选列表让用户确认
      await fetchAndParseTorrentUrl(trimmed);
      return;
    }

    if (parsedTorrent && selectedFiles.size === 0) {
      setError(t("add.torrentNoSelection"));
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        url: torrentBase64 && trimmed.startsWith("torrent://") ? "" : trimmed,
        fileName: fileName.trim() || null,
        connections: Math.max(1, Math.min(32, Number(connections) || defaultConnections)),
        referrer: referrer.trim() || null,
        checksumSha256: checksum.trim() || null,
        torrentBytesBase64: torrentBase64,
        onlyFiles: parsedTorrent ? Array.from(selectedFiles).sort((a, b) => a - b) : null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{t("add.title")}</h2>
            <div className="hint">{t("add.subtitle")}</div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="field">
              <label>{t("add.url")}</label>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="text"
                  value={url}
                  onChange={(e) => {
                    const nextVal = e.target.value;
                    setUrl(nextVal);
                    if (parsedTorrent && !nextVal.startsWith("torrent://") && nextVal !== initialUrl) {
                      setTorrentBase64(null);
                      setTorrentName(null);
                      setParsedTorrent(null);
                      setSelectedFiles(new Set());
                    }
                  }}
                  placeholder={t("add.urlPlaceholder")}
                  autoFocus
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".torrent,application/x-bittorrent"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.currentTarget.value = "";
                    if (f) void handleTorrentFilePick(f);
                  }}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => fileInputRef.current?.click()}
                >
                  {t("add.pickTorrent")}
                </button>
              </div>
              {torrentName && (
                <div className="hint ok">{t("add.torrentSelected", { name: torrentName })}</div>
              )}
              {parsingTorrent && <div className="hint">{t("add.torrentLoading")}</div>}
            </div>

            {parsedTorrent && parsedTorrent.files.length > 1 && (
              <div className="field">
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <label style={{ margin: 0 }}>{t("add.torrentFilesTitle")}</label>
                  <span className="hint" style={{ marginLeft: "4px" }}>
                    {t("add.torrentSummary", {
                      selected: selectedFiles.size,
                      total: parsedTorrent.files.length,
                      size: formatBytes(selectedBytes),
                    })}
                  </span>
                  <div className="spacer" />
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      setSelectedFiles(new Set(parsedTorrent.files.map((f) => f.index)))
                    }
                  >
                    {t("bt.selectAll")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setSelectedFiles(new Set())}
                  >
                    {t("bt.clear")}
                  </button>
                </div>

                <div
                  style={{
                    maxHeight: "220px",
                    overflowY: "auto",
                    border: "1px solid var(--line)",
                    borderRadius: "10px",
                    background: "var(--surface-2)",
                  }}
                >
                  {parsedTorrent.files.map((file) => {
                    const checked = selectedFiles.has(file.index);
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
                        <span className="mono muted" style={{ fontSize: "11px" }}>
                          #{file.index + 1}
                        </span>
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
                        <span className="mono muted">{formatBytes(file.length)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="field-row">
              <div className="field">
                <label>{t("add.fileName")}</label>
                <input
                  type="text"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  placeholder={parsedTorrent?.name || t("add.fileNamePlaceholder")}
                />
              </div>

              <div className="field">
                <label>{t("add.connections")} (1–32)</label>
                <input
                  type="number"
                  min={1}
                  max={32}
                  value={connections}
                  onChange={(e) => setConnections(Number(e.target.value))}
                />
              </div>
            </div>

            <div className="field-row">
              <div className="field">
                <label>{t("add.referrer")}</label>
                <input
                  type="text"
                  value={referrer}
                  onChange={(e) => setReferrer(e.target.value)}
                  placeholder={t("add.referrerPlaceholder")}
                />
              </div>

              <div className="field">
                <label>{t("add.checksum")}</label>
                <input
                  type="text"
                  value={checksum}
                  onChange={(e) => setChecksum(e.target.value)}
                  placeholder={t("add.checksumPlaceholder")}
                />
              </div>
            </div>

            {error && (
              <div
                style={{
                  padding: "9px 12px",
                  borderRadius: "9px",
                  background: "var(--red-soft)",
                  color: "var(--red)",
                  fontSize: "12px",
                }}
              >
                {error}
              </div>
            )}
          </div>

          <div className="modal-foot">
            <button type="button" className="btn" onClick={onClose}>
              {t("add.cancel")}
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting || parsingTorrent}
            >
              {submitting ? t("add.starting") : t("add.start")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
