import { createRequestId, type ExtensionRequest, type ExtensionResponse } from "../shared/protocol";
import type { AddTaskInput, Settings } from "../shared/types";

function showPageToast(text: string, isError = false): void {
  const existing = document.getElementById("tug-web-toast");
  if (existing) {
    existing.remove();
  }

  const toast = document.createElement("div");
  toast.id = "tug-web-toast";
  toast.textContent = text;
  Object.assign(toast.style, {
    position: "fixed",
    right: "20px",
    bottom: "20px",
    zIndex: "2147483647",
    padding: "10px 16px",
    borderRadius: "12px",
    fontFamily:
      '"MiSans", "HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif',
    fontSize: "13px",
    fontWeight: "600",
    color: isError ? "#FFFFFF" : "#FFFFFF",
    backgroundColor: isError ? "#B3261E" : "#676728",
    boxShadow: "0 10px 28px rgba(0, 0, 0, 0.22)",
    transition: "opacity 0.25s ease",
    pointerEvents: "none",
  });

  document.body?.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 260);
  }, 2800);
}

async function shouldInterceptPageClick(isMagnet: boolean): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get("tugWebSettings");
    const settings = stored?.tugWebSettings as Partial<Settings> | undefined;
    if (!settings) return true;
    return isMagnet
      ? settings.interceptMagnetLinks !== false
      : settings.interceptTorrentFiles !== false;
  } catch {
    return true;
  }
}

document.addEventListener(
  "click",
  (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;

    const href = (anchor.href || anchor.getAttribute("href") || "").trim();
    if (!href) return;

    const lower = href.toLowerCase();
    const isMagnet = lower.startsWith("magnet:?xt=urn:btih:");
    let isTorrentUrl = false;
    if (!isMagnet && (lower.startsWith("http://") || lower.startsWith("https://"))) {
      try {
        const parsed = new URL(href);
        isTorrentUrl = parsed.pathname.toLowerCase().endsWith(".torrent");
      } catch {
        isTorrentUrl = false;
      }
    }

    if (!isMagnet && !isTorrentUrl) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    void (async () => {
      const enabled = await shouldInterceptPageClick(isMagnet);
      if (!enabled) {
        window.location.href = href;
        return;
      }

      const req: ExtensionRequest<AddTaskInput | { url: string; referrer?: string }> =
        isTorrentUrl
          ? {
              channel: "tug-web-rpc",
              target: "background",
              type: "handle_torrent_url",
              requestId: createRequestId(),
              payload: {
                url: href,
                referrer: window.location.href,
              },
            }
          : {
              channel: "tug-web-rpc",
              target: "background",
              type: "add_task",
              requestId: createRequestId(),
              payload: {
                url: href,
                referrer: window.location.href,
              },
            };

      chrome.runtime.sendMessage(
        req,
        (resp: ExtensionResponse<{ startedDirectly?: boolean }> | undefined) => {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            showPageToast(
              `Tug Web 添加失败：${resp && !resp.ok ? resp.error.message : "请重试"}`,
              true,
            );
            return;
          }
          if (isMagnet) {
            showPageToast("已交由 Tug Web 下载磁力链接");
          } else if (resp.data?.startedDirectly) {
            showPageToast("已交由 Tug Web 开始下载种子任务");
          } else {
            showPageToast("已打开 Tug Web，请确认要下载的种子文件");
          }
        },
      );
    })();
  },
  true,
);
