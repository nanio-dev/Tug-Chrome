import { AGENT_DOWNLOAD_URL } from "../shared/agent-package";
import { translate } from "../shared/i18n/catalog";
import { resolveLocale } from "../shared/i18n/locales";
import type { MessageKey } from "../shared/i18n/zh-CN";
import {
  extractDownloadCandidate,
  guessFileNameFromUrl,
  sanitizeFileName,
  shouldInterceptBrowserDownload,
} from "../shared/filename";
import {
  createRequestId,
  type AgentInstallState,
  type ExportBlobPayload,
  type ExtensionBroadcastMessage,
  type ExtensionRequest,
  type ExtensionResponse,
  type NativeHelperStatus,
  type PrepareHeadersPayload,
} from "../shared/protocol";
import {
  checkHelperHealth,
  readHelperCredentials,
  setHelperCredentials,
  deleteFileViaHelper,
  connectHelperNative,
  disconnectHelperNative,
  openFileViaHelper,
  registerExtIdWithHelper,
  uninstallViaHelper,
} from "../engine/torrent/native-helper";
import { parseTorrentBuffer, uint8ArrayToBase64 } from "../engine/torrent/parser";
import {
  DEFAULT_SETTINGS,
  isActiveTaskState,
  canOpenTaskFile,
  normalizeSettings,
  type AddTaskInput,
  type Settings,
  type TaskView,
} from "../shared/types";

let creatingOffscreen: Promise<void> | null = null;
const selfExportedDownloadIds = new Set<number>();
const pendingBlobExports = new Map<string, string>();
const activeExports = new Map<string, { canceled: boolean; downloadId: number | null }>();
let cachedSettings: Settings = { ...DEFAULT_SETTINGS };
let settingsInitialized = false;
let settingsInitPromise: Promise<void> | null = null;

function t(key: MessageKey, params?: Record<string, string | number>): string {
  return translate(resolveLocale(cachedSettings.locale), key, params);
}

async function loadCachedSettings(forceRefresh = false): Promise<Settings> {
  if (forceRefresh || !settingsInitialized) {
    if (forceRefresh || !settingsInitPromise) {
      settingsInitPromise = (async () => {
        try {
          const stored = await chrome.storage.local.get("tugWebSettings");
          if (stored?.tugWebSettings) {
            cachedSettings = normalizeSettings(stored.tugWebSettings as Partial<Settings>);
          }
          settingsInitialized = true;
        } catch {
          // ignore
        }
      })();
    }
    await settingsInitPromise;
  }
  return cachedSettings;
}

chrome.storage?.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.tugWebSettings?.newValue) {
    cachedSettings = normalizeSettings(changes.tugWebSettings.newValue as Partial<Settings>);
    if (cachedSettings.standaloneMode) disconnectHelperNative();
    settingsInitialized = true;
  }
});

void loadCachedSettings();

async function ensureOffscreenDocument(): Promise<void> {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  if ("getContexts" in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [offscreenUrl],
    });
    if (contexts.length > 0) {
      return;
    }
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: [
        chrome.offscreen.Reason.BLOBS,
        chrome.offscreen.Reason.WORKERS,
        chrome.offscreen.Reason.WEB_RTC,
      ],
      justification:
        "Host multi-connection HTTP Range download workers, OPFS file assembly, and WebRTC P2P sessions.",
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("Only a single offscreen")) {
        throw err;
      }
    })
    .finally(() => {
      creatingOffscreen = null;
    });

  await creatingOffscreen;
}

async function forwardToOffscreen<TResponse = unknown, TPayload = unknown>(
  type: ExtensionRequest["type"],
  payload?: TPayload,
): Promise<TResponse> {
  await ensureOffscreenDocument();
  const req: ExtensionRequest<TPayload> = {
    channel: "tug-web-rpc",
    target: "offscreen",
    type,
    requestId: createRequestId(),
    payload: (payload ?? {}) as TPayload,
  };

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(req, (resp: ExtensionResponse<TResponse> | undefined) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!resp) {
        reject(new Error(t("error.offscreen")));
        return;
      }
      if (!resp.ok) {
        reject(new Error(resp.error.message));
        return;
      }
      resolve(resp.data);
    });
  });
}

async function applySessionHeaderRules(payload: PrepareHeadersPayload): Promise<void> {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  const ruleId = 10000 + (payload.taskId % 50000);
  const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [];

  if (payload.referrer && payload.referrer.trim()) {
    requestHeaders.push({
      header: "Referer",
      operation: chrome.declarativeNetRequest.HeaderOperation.SET,
      value: payload.referrer.trim(),
    });
  }

  for (const [name, value] of payload.headers ?? []) {
    if (!name || !value) continue;
    if (name.toLowerCase() === "referer" && payload.referrer) continue;
    requestHeaders.push({
      header: name,
      operation: chrome.declarativeNetRequest.HeaderOperation.SET,
      value,
    });
  }

  if (requestHeaders.length === 0) return;

  let urlFilter = payload.url;
  try {
    const parsed = new URL(payload.url);
    urlFilter = `||${parsed.hostname}/`;
  } catch {
    // keep raw url
  }

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [
      {
        id: ruleId,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders,
        },
        condition: {
          urlFilter,
          resourceTypes: [
            chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
            chrome.declarativeNetRequest.ResourceType.OTHER,
          ],
        },
      },
    ],
  });
}

async function clearSessionHeaderRules(taskId: number): Promise<void> {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  const ruleId = 10000 + (taskId % 50000);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
  });
}

if (chrome.downloads?.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const expected =
      (item.finalUrl ? pendingBlobExports.get(item.finalUrl) : undefined) ??
      pendingBlobExports.get(item.url);
    if (expected) {
      suggest({ filename: expected, conflictAction: "uniquify" });
      return;
    }
    if (item.byExtensionId === chrome.runtime.id && item.filename) {
      suggest({ filename: item.filename, conflictAction: "uniquify" });
    }
  });
}

async function exportBlobToDownloads(
  payload: ExportBlobPayload,
): Promise<{ downloadId: number | null; savedPath?: string | null }> {
  const control = { canceled: false, downloadId: null as number | null };
  activeExports.set(payload.exportId, control);
  const segments = payload.relativePath
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .map((seg) => sanitizeFileName(seg, ""))
    .filter(Boolean);
  const cleanFilename = segments.join("/") || "download";
  const fallbackBaseName = segments[segments.length - 1] || "download";

  pendingBlobExports.set(payload.blobUrl, cleanFilename);

  try {
    let downloadId: number | undefined;
    try {
      downloadId = await chrome.downloads.download({
        url: payload.blobUrl,
        filename: cleanFilename,
        conflictAction: "uniquify",
        saveAs: false,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isUserCancel = /cancel|user|abort|interrupted/i.test(errMsg);
      const isFilenameIssue = /filename|invalid/i.test(errMsg);
      if (!isUserCancel && isFilenameIssue && cleanFilename !== fallbackBaseName) {
        pendingBlobExports.set(payload.blobUrl, fallbackBaseName);
        downloadId = await chrome.downloads.download({
          url: payload.blobUrl,
          filename: fallbackBaseName,
          conflictAction: "uniquify",
          saveAs: false,
        });
      } else if (isUserCancel) {
        throw new Error(t("error.saveCancelled"));
      } else {
        throw err;
      }
    }

    if (typeof downloadId !== "number") {
      throw new Error(t("error.saveCancelled"));
    }

    control.downloadId = downloadId;
    selfExportedDownloadIds.add(downloadId);
    if (control.canceled) await chrome.downloads.cancel(downloadId).catch(() => {});
    let wasErased = false;
    let interruptedError: string | null = null;

    // 等待系统下载导出完成（同时监听 onChanged / onErased，并立即查询一次避免错过瞬间完成的事件）
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        chrome.downloads.onChanged.removeListener(onChanged);
        chrome.downloads.onErased?.removeListener(onErased);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(t("error.saveTimeout")));
      }, 600000);
      const onChanged = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id !== downloadId) return;
        if (delta.error?.current) {
          interruptedError = delta.error.current;
        }
        if (
          delta.state?.current === "complete" ||
          delta.state?.current === "interrupted" ||
          Boolean(delta.error?.current)
        ) {
          finish();
        }
      };
      const onErased = (erasedId: number) => {
        if (erasedId !== downloadId) return;
        wasErased = true;
        finish();
      };
      chrome.downloads.onChanged.addListener(onChanged);
      chrome.downloads.onErased?.addListener(onErased);

      void chrome.downloads
        .search({ id: downloadId })
        .then((items) => {
          const cur = items[0];
          if (!cur) {
            wasErased = true;
            finish();
            return;
          }
          if (cur.error) {
            interruptedError = cur.error;
          }
          if (cur.state === "complete" || cur.state === "interrupted") {
            finish();
          }
        })
        .catch(() => {});
    });

    const items = await chrome.downloads.search({ id: downloadId }).catch(() => []);
    const item = items[0];
    if (
      wasErased ||
      interruptedError ||
      !item ||
      item.state !== "complete" ||
      item.exists === false ||
      !item.filename
    ) {
      const reason =
        item?.error || interruptedError || (wasErased || !item ? "USER_CANCELED" : "EXPORT_INCOMPLETE");
      throw new Error(
        reason === "USER_CANCELED"
          ? t("error.saveCancelled")
          : t("error.exportFailed", { reason }),
      );
    }

    return { downloadId, savedPath: item.filename };
  } finally {
    pendingBlobExports.delete(payload.blobUrl);
    activeExports.delete(payload.exportId);
  }
}

async function openManagerTab(initialUrl?: string): Promise<void> {
  const baseUrl = chrome.runtime.getURL("manager.html");
  const targetUrl = initialUrl
    ? `${baseUrl}?add=${encodeURIComponent(initialUrl)}`
    : baseUrl;

  const existingTabs = await chrome.tabs.query({ url: `${baseUrl}*` });
  if (existingTabs.length > 0 && existingTabs[0].id !== undefined) {
    const tab = existingTabs[0];
    if (initialUrl) {
      await chrome.tabs.update(tab.id!, { url: targetUrl, active: true });
    } else {
      await chrome.tabs.update(tab.id!, { active: true });
    }
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    return;
  }

  await chrome.tabs.create({ url: targetUrl, active: true });
}

let extIdRegisteredInSession = false;
let agentUninstalling = false;

async function ensureExtIdRegisteredOnce(): Promise<void> {
  if (extIdRegisteredInSession) return;
  const ok = await registerExtIdWithHelper(chrome.runtime.id);
  if (ok) {
    extIdRegisteredInSession = true;
  }
}

async function activateNativeHelperViaProtocol(protocolTabId?: number): Promise<NativeHelperStatus> {
  const existing = await checkHelperHealth(800);
  if (existing.available) {
    if (protocolTabId !== undefined) await chrome.tabs.remove(protocolTabId).catch(() => {});
    await ensureExtIdRegisteredOnce();
    return existing;
  }

  const protoUrl = `tug-agent://register?extId=${encodeURIComponent(chrome.runtime.id)}`;
  let helperTabId = protocolTabId;
  try {
    if (helperTabId === undefined) {
      const tab = await chrome.tabs.create({ url: protoUrl, active: true });
      helperTabId = tab.id;
    }
  } catch {
    // ignore
  }

  for (let i = 0; i < 18; i += 1) {
    await new Promise((r) => setTimeout(r, 400));
    const status = await connectHelperNative(1500, message => logDiag("pair", message));
    if (status.available) {
      await ensureExtIdRegisteredOnce();
      if (helperTabId !== undefined) {
        await chrome.tabs.remove(helperTabId).catch(() => {});
      }
      return status;
    }
  }

  if (helperTabId !== undefined) {
    await chrome.tabs.remove(helperTabId).catch(() => {});
  }
  return checkHelperHealth(800);
}

async function ensureNativeHelperRunning(options?: {
  allowProtocolFallback?: boolean;
  management?: boolean;
}): Promise<NativeHelperStatus> {
  await loadCachedSettings();
  if (agentUninstalling) return { available: false };
  if (cachedSettings.standaloneMode && !options?.management) {
    return { available: false, standaloneMode: true };
  }

  const initial = await checkHelperHealth(900);
  if (initial.available) {
    setAgentReadyBadge(false);
    void ensureExtIdRegisteredOnce();
    return { ...initial, installed: true };
  }

  // No external-protocol prompt is needed to bootstrap a running Agent.
  if (initial.pairingRequired) await registerExtIdWithHelper(chrome.runtime.id);
  const native = await connectHelperNative(8000, message => logDiag("probe", message));
  if (native.available) {
    setAgentReadyBadge(false);
    logDiag("probe", "Agent connected and authenticated via Native Messaging");
    await ensureExtIdRegisteredOnce();
    return { ...native, installed: true };
  }

  if (options?.allowProtocolFallback) {
    const protoStatus = await activateNativeHelperViaProtocol();
    return { ...protoStatus, installed: protoStatus.available };
  }

  const finalStatus = await checkHelperHealth(500);
  return { ...native, ...finalStatus, installed: finalStatus.installed || native.installed };
}

const DIAG_LOGS_STORAGE_KEY = "tugWebDiagLogs";
const MAX_DIAG_LOGS = 120;
let diagLogsCache: string[] | null = null;

async function getDiagnosticLogsList(): Promise<string[]> {
  if (diagLogsCache) return diagLogsCache;
  try {
    const res = await chrome.storage.local.get(DIAG_LOGS_STORAGE_KEY);
    const arr = res[DIAG_LOGS_STORAGE_KEY];
    diagLogsCache = Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    diagLogsCache = [];
  }
  return diagLogsCache;
}

function logDiag(scope: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${scope}] ${message}`;
  console.info(line);
  void getDiagnosticLogsList().then((list) => {
    list.push(line);
    if (list.length > MAX_DIAG_LOGS) {
      list.splice(0, list.length - MAX_DIAG_LOGS);
    }
    diagLogsCache = list;
    return chrome.storage.local.set({ [DIAG_LOGS_STORAGE_KEY]: list }).catch(() => {});
  });
}

let agentInstallState: AgentInstallState = {
  phase: "idle",
  bytesReceived: 0,
  totalBytes: 0,
  downloadId: null,
};

async function waitForAgentHealthAndRegister(timeoutMs: number): Promise<NativeHelperStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await ensureNativeHelperRunning({ allowProtocolFallback: false });
    if (st.available) {
      await ensureExtIdRegisteredOnce();
      return st;
    }
    if (st.updateRequired || st.pairingRequired) return st;
    await new Promise((r) => setTimeout(r, 350));
  }
  return { available: false };
}

function setAgentReadyBadge(pendingLaunch: boolean): void {
  if (!chrome.action?.setBadgeText) return;
  if (pendingLaunch) {
    void chrome.action.setBadgeBackgroundColor({ color: "#D97706" }).catch(() => {});
    void chrome.action.setBadgeText({ text: "1" }).catch(() => {});
  } else {
    void chrome.action.setBadgeText({ text: "" }).catch(() => {});
  }
}

let pendingAgentBlobUrl: string | null = null;
let installGeneration = 0;
let installStateLoading: Promise<void> | null = null;
let installStateSave: Promise<unknown> = Promise.resolve();
let lastInstallSave = 0;
const INSTALL_SESSION_KEY = "tugAgentInstallSession";
function setAgentInstallState(next: AgentInstallState): void {
  const phaseChanged = agentInstallState.phase !== next.phase;
  agentInstallState = next;
  if (!phaseChanged && next.phase === "downloading" && Date.now() - lastInstallSave < 1000) return;
  lastInstallSave = Date.now();
  const saved = { state: { ...next }, blobUrl: pendingAgentBlobUrl };
  installStateSave = installStateSave.catch(() => {}).then(() => chrome.storage.session.set({ [INSTALL_SESSION_KEY]: saved }));
}
function resetAgentInstallation(): void {
  installGeneration++;
  pendingAgentBlobUrl = null;
  setAgentReadyBadge(false);
  setAgentInstallState({ phase: "idle", bytesReceived: 0, totalBytes: 0, downloadId: null });
}
function loadAgentInstallState(): Promise<void> {
  if (!installStateLoading) installStateLoading = (async () => {
    const saved = (await chrome.storage.session.get(INSTALL_SESSION_KEY))[INSTALL_SESSION_KEY] as { state?: AgentInstallState; blobUrl?: string } | undefined;
    if (!saved?.state) return;
    agentInstallState = saved.state;
    pendingAgentBlobUrl = typeof saved.blobUrl === "string" ? saved.blobUrl : null;
    if (["checking", "downloading", "launching", "waiting_ready"].includes(agentInstallState.phase)) {
      setAgentInstallState({ ...agentInstallState, phase: "error", message: t("agentInstall.interrupted") });
    }
  })().catch(() => {});
  return installStateLoading;
}

async function launchDownloadedAgentById(downloadId: number): Promise<AgentInstallState> {
  const attempt = installGeneration;
  logDiag("activate", `launching from UI gesture for downloadId=${downloadId}`);
  setAgentInstallState({
    ...agentInstallState,
    phase: "waiting_ready",
    downloadId,
    message: undefined,
  });
  const status = await waitForAgentHealthAndRegister(15000);
  if (attempt !== installGeneration) return agentInstallState;
  if (status.available) {
    logDiag("activate", `agent health OK and registered for downloadId=${downloadId}`);
    setAgentInstallState({ ...agentInstallState, phase: "ready", downloadId });
    setAgentReadyBadge(false);
  } else if (status.pairingRequired) {
    setAgentInstallState({ ...agentInstallState, phase: "need_pairing", downloadId });
    logDiag("activate", "Agent is running; browser pairing is required");
  } else {
    logDiag("activate", `agent activation incomplete (15s) for downloadId=${downloadId}`);
    setAgentInstallState({
      ...agentInstallState,
      phase: "error",
      downloadId,
      message: status.updateRequired
        ? t("agentInstall.updateRequired")
        : t("agentInstall.connectionFailed"),
    });
    setAgentReadyBadge(false);
  }
  return agentInstallState;
}

async function exportDownloadedAgent(): Promise<AgentInstallState> {
  const blobUrl = pendingAgentBlobUrl;
  if (!blobUrl) {
    setAgentInstallState({
      phase: "error",
      bytesReceived: 0,
      totalBytes: 0,
      downloadId: null,
      message: t("agentInstall.cacheExpired"),
    });
    return agentInstallState;
  }

  try {
    const installerName = "tug-agent.exe";
    pendingBlobExports.set(blobUrl, installerName);
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: installerName,
      conflictAction: "overwrite",
      saveAs: false,
    });
    selfExportedDownloadIds.add(downloadId);
    logDiag("activate", `chrome.downloads.download returned id=${downloadId}`);
    setAgentInstallState({
      ...agentInstallState,
      phase: "confirming_save",
      downloadId,
    });

    void (async () => {
      for (let i = 0; i < 600; i += 1) {
        await new Promise((r) => setTimeout(r, 150));
        const items = await chrome.downloads.search({ id: downloadId }).catch(() => []);
        const item = items[0];
        if (agentInstallState.downloadId !== downloadId || agentInstallState.phase !== "confirming_save") return;
        if (!item) {
          logDiag("activate", `downloadId=${downloadId} search returned empty`);
          setAgentInstallState({
            ...agentInstallState,
            phase: "error",
            message: t("agentInstall.downloadMissing"),
          });
          return;
        }
        if (item.state === "in_progress") {
          continue;
        }
        if (item.state === "complete") {
          logDiag("activate", `downloadId=${downloadId} state=complete (filename=${item.filename || ""})`);
          pendingAgentBlobUrl = null;
          setAgentInstallState({
            ...agentInstallState,
            phase: "need_manual_launch",
            downloadId,
          });
          setAgentReadyBadge(true);
          if (chrome.notifications?.create) {
            void chrome.notifications.create(`tug-agent-launch-${downloadId}`, {
              type: "basic",
              iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
              title: t("agentInstall.notificationTitle"),
              message: t("agentInstall.notificationBody"),
            });
          }
          return;
        }
        if (item.state === "interrupted") {
          logDiag("activate", `downloadId=${downloadId} state=interrupted (error=${item.error || ""})`);
          pendingAgentBlobUrl = null;
          setAgentInstallState({
            ...agentInstallState,
            phase: "error",
            message: item.error || t("agentInstall.downloadCancelled"),
          });
          return;
        }
      }
      if (agentInstallState.downloadId === downloadId && agentInstallState.phase === "confirming_save") {
        setAgentInstallState({ ...agentInstallState, phase: "error", message: t("agentInstall.downloadTimeout") });
      }
    })();

    return agentInstallState;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logDiag("activate", `exportDownloadedAgent error: ${msg}`);
    setAgentInstallState({
      ...agentInstallState,
      phase: "error",
      message: msg,
    });
    return agentInstallState;
  }
}

async function startInstallNativeAgent(): Promise<AgentInstallState> {
  if (pendingAgentBlobUrl && agentInstallState.phase === "error") {
    setAgentInstallState({ ...agentInstallState, phase: "confirming_save", downloadId: null, message: undefined });
    return agentInstallState;
  }
  if (["checking", "downloading", "confirming_save", "launching", "waiting_ready", "need_manual_launch"].includes(agentInstallState.phase)) return agentInstallState;
  const attempt = ++installGeneration;
  pendingAgentBlobUrl = null;
  setAgentReadyBadge(false);
  setAgentInstallState({
    phase: "checking",
    bytesReceived: 0,
    totalBytes: 0,
    downloadId: null,
  });

  // 若本机已安装且能唤醒，直接激活完成
  const existing = await ensureNativeHelperRunning({ allowProtocolFallback: false });
  if (attempt !== installGeneration) return agentInstallState;
  if (existing.available) {
    setAgentInstallState({
      phase: "ready",
      bytesReceived: 0,
      totalBytes: 0,
      downloadId: null,
    });
    return agentInstallState;
  }

  if (existing.pairingRequired) {
    setAgentInstallState({ phase: "need_pairing", bytesReceived: 0, totalBytes: 0, downloadId: null });
    return agentInstallState;
  }

  setAgentInstallState({
    phase: "downloading",
    bytesReceived: 0,
    totalBytes: 0,
    downloadId: null,
  });

  void (async () => {
    try {
      logDiag("activate", `starting offscreen fetch from ${AGENT_DOWNLOAD_URL}`);
      const { blobUrl, totalBytes } = await forwardToOffscreen<
        { blobUrl: string; totalBytes: number },
        { url: string }
      >("download_agent_binary", { url: `${AGENT_DOWNLOAD_URL}?t=${Date.now()}` });
      logDiag("activate", `offscreen download complete (${totalBytes} bytes), waiting for user confirm`);

      if (attempt !== installGeneration) return;
      pendingAgentBlobUrl = blobUrl;
      setAgentInstallState({
        phase: "confirming_save",
        bytesReceived: totalBytes,
        totalBytes,
        downloadId: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt !== installGeneration) return;
      logDiag("activate", `startInstallNativeAgent error: ${msg}`);
      setAgentInstallState({
        phase: "error",
        bytesReceived: 0,
        totalBytes: 0,
        downloadId: null,
        message: msg,
      });
    }
  })();

  return agentInstallState;
}

async function findBrowserDownloadIdForTask(task: TaskView): Promise<number | null> {
  if (!chrome.downloads?.search) return null;

  if (task.chromeDownloadId !== null && task.chromeDownloadId !== undefined) {
    try {
      const items = await chrome.downloads.search({ id: task.chromeDownloadId });
      const item = items[0];
      if (item && item.exists !== false && item.state === "complete") {
        return item.id;
      }
    } catch {
      // ignore invalid or erased downloadId
    }
  }

  const candidates = [task.fileName, task.name].filter((s): s is string => Boolean(s && s.trim()));
  for (const name of candidates) {
    try {
      const items = await chrome.downloads.search({
        query: [name],
        state: "complete",
        exists: true,
        orderBy: ["-startTime"],
        limit: 10,
      });
      const lowerName = name.toLowerCase();
      const matched =
        items.find((it) => {
          const fn = (it.filename || "").replace(/\\/g, "/").toLowerCase();
          return fn.endsWith(`/${lowerName}`) || fn === lowerName;
        }) ?? items[0];
      if (matched) {
        return matched.id;
      }
    } catch {
      // ignore search errors
    }
  }

  return null;
}

function tryOpenBrowserDownload(downloadId: number): boolean {
  try {
    chrome.downloads.open(downloadId);
    return true;
  } catch {
    try {
      chrome.downloads.show(downloadId);
    } catch {
      // ignore
    }
    return false;
  }
}

async function handleBackgroundCommand(req: ExtensionRequest): Promise<unknown> {
  await loadCachedSettings();
  await loadAgentInstallState();

  switch (req.type) {
    case "get_agent_credentials": {
      const status = await ensureNativeHelperRunning({ allowProtocolFallback: false });
      if (!status.available) throw new Error(t("error.agentConnect"));
      return { token: await readHelperCredentials() };
    }
    case "get_native_helper_status": {
      if (cachedSettings.standaloneMode) {
        return { available: false, standaloneMode: true };
      }
      const status = await checkHelperHealth(900);
      if (status.available) {
        void ensureExtIdRegisteredOnce();
      }
      return status;
    }
    case "ensure_native_helper":
      if (cachedSettings.standaloneMode) {
        return { available: false, standaloneMode: true };
      }
      return ensureNativeHelperRunning(
        req.payload as { allowProtocolFallback?: boolean } | undefined,
      );
    case "activate_native_helper_protocol": {
      const status = await activateNativeHelperViaProtocol((req.payload as { protocolTabId?: number })?.protocolTabId);
      if (status.available) setAgentInstallState({ ...agentInstallState, phase: "ready", message: undefined });
      return status;
    }
    case "install_native_agent":
      return startInstallNativeAgent();
    case "get_agent_install_state": {
      if (agentInstallState.phase === "confirming_save" && agentInstallState.downloadId !== null) {
        const item = (await chrome.downloads.search({ id: agentInstallState.downloadId }))[0];
        if (item?.state === "complete") setAgentInstallState({ ...agentInstallState, phase: "need_manual_launch" });
        else if (!item || item.state === "interrupted") setAgentInstallState({ ...agentInstallState, phase: "error", message: item?.error || t("agentInstall.downloadIncomplete") });
      }
      return agentInstallState;
    }
    case "report_agent_install_progress": {
      const p = req.payload as { bytesReceived: number; totalBytes: number };
      if (agentInstallState.phase === "downloading") {
        setAgentInstallState({
          ...agentInstallState,
          bytesReceived: p.bytesReceived,
          totalBytes: p.totalBytes,
        });
      }
      return { ok: true };
    }
    case "export_downloaded_agent":
      return exportDownloadedAgent();
    case "launch_downloaded_agent": {
      const payload = req.payload as { downloadId: number };
      return launchDownloadedAgentById(payload.downloadId);
    }
    case "reset_agent_install_state":
      resetAgentInstallation();
      return agentInstallState;
    case "uninstall_native_agent": {
      let status = await checkHelperHealth(500);
      if (!status.available) {
        status = await ensureNativeHelperRunning({ allowProtocolFallback: false, management: true });
      }
      if (!status.available) {
        return { uninstalled: false };
      }
      agentUninstalling = true;
      try {
        const ok = await uninstallViaHelper();
        if (!ok) throw new Error(t("error.uninstall"));
        disconnectHelperNative();
        await setHelperCredentials(null);
        resetAgentInstallation();
        await installStateSave;
        cachedSettings = await forwardToOffscreen<Settings>("update_settings", { standaloneMode: true });
        extIdRegisteredInSession = false;
        setAgentReadyBadge(false);
        logDiag("uninstall", "Agent directory removed and host registrations cleared");
        return { uninstalled: true };
      } finally { agentUninstalling = false; }
    }

    case "get_diagnostic_logs":
      return getDiagnosticLogsList();
    case "clear_diagnostic_logs":
      diagLogsCache = [];
      await chrome.storage.local.remove(DIAG_LOGS_STORAGE_KEY).catch(() => {});
      return { ok: true };
    case "prepare_request_headers":
      await applySessionHeaderRules(req.payload as PrepareHeadersPayload);
      return { ok: true };
    case "clear_request_headers":
      await clearSessionHeaderRules((req.payload as { taskId: number }).taskId);
      return { ok: true };
    case "export_blob_to_downloads":
      return exportBlobToDownloads(req.payload as ExportBlobPayload);
    case "cancel_task_export": {
      const active = activeExports.get((req.payload as { exportId: string }).exportId);
      if (active) {
        active.canceled = true;
        if (active.downloadId !== null) await chrome.downloads.cancel(active.downloadId).catch(() => {});
      }
      return { ok: true };
    }
    case "open_manager_tab":
      await openManagerTab((req.payload as { initialUrl?: string })?.initialUrl);
      return { ok: true };
    case "handle_torrent_url": {
      const payload = req.payload as { url: string; referrer?: string | null };
      return handleTorrentUrlSmart(payload.url, payload.referrer);
    }
    case "open_downloads_folder": {
      if (!cachedSettings.standaloneMode) {
        const helper = await checkHelperHealth(250);
        if (helper.available) {
          const res = await openFileViaHelper({
            action: "open_folder",
            subDir: cachedSettings.downloadSubdir,
          });
          if (res?.ok) {
            return { opened: true };
          }
        }
      }
      chrome.downloads.showDefaultFolder();
      return { opened: true };
    }
    case "open_task_file": {
      const { id } = req.payload as { id: number };
      const tasks = await forwardToOffscreen<TaskView[]>("list_tasks");
      const task = tasks.find((t) => t.id === id);
      if (task && !canOpenTaskFile(task)) throw new Error(t("error.multipleFiles"));
      const browserDownloadId = task ? await findBrowserDownloadIdForTask(task) : null;

      if (
        browserDownloadId !== null &&
        (cachedSettings.standaloneMode || task?.chromeDownloadId !== null)
      ) {
        tryOpenBrowserDownload(browserDownloadId);
        return { opened: true };
      }

      if (!cachedSettings.standaloneMode && task) {
        const helper = await checkHelperHealth(250);
        if (helper.available) {
          const res = await openFileViaHelper({
            action: "open_file",
            path: task.path || task.fileName || task.name,
            subDir: cachedSettings.downloadSubdir,
          });
          if (res?.ok) {
            return { opened: Boolean(res.opened) };
          }
        }
      }

      if (browserDownloadId !== null) {
        tryOpenBrowserDownload(browserDownloadId);
        return { opened: true };
      }

      chrome.downloads.showDefaultFolder();
      return { opened: false };
    }
    case "reveal_task_file": {
      const { id } = req.payload as { id: number };
      const tasks = await forwardToOffscreen<TaskView[]>("list_tasks");
      const task = tasks.find((t) => t.id === id);
      const browserDownloadId = task ? await findBrowserDownloadIdForTask(task) : null;

      if (
        browserDownloadId !== null &&
        (cachedSettings.standaloneMode || task?.chromeDownloadId !== null)
      ) {
        chrome.downloads.show(browserDownloadId);
        return { revealed: true };
      }

      if (!cachedSettings.standaloneMode && task) {
        const helper = await checkHelperHealth(250);
        if (helper.available) {
          const res = await openFileViaHelper({
            action: "reveal_file",
            path: task.path || task.fileName || task.name,
            subDir: cachedSettings.downloadSubdir,
          });
          if (res?.ok) {
            return { revealed: Boolean(res.revealed) };
          }
        }
      }

      if (browserDownloadId !== null) {
        chrome.downloads.show(browserDownloadId);
        return { revealed: true };
      }

      chrome.downloads.showDefaultFolder();
      return { revealed: false };
    }
    case "remove_task": {
      const { id, deleteFiles } = req.payload as { id: number; deleteFiles: boolean };
      if (deleteFiles) {
        const tasks = await forwardToOffscreen<TaskView[]>("list_tasks").catch(() => [] as TaskView[]);
        const target = tasks.find((t) => t.id === id);
        if (target?.chromeDownloadId !== null && target?.chromeDownloadId !== undefined) {
          await chrome.downloads.removeFile(target.chromeDownloadId).catch(() => {});
          await chrome.downloads.erase({ id: target.chromeDownloadId }).catch(() => {});
        }
        if (target?.path && !cachedSettings.standaloneMode) {
          const helper = await checkHelperHealth(250);
          if (helper.available) {
            await deleteFileViaHelper(target.path).catch(() => {});
          }
        }
      }
      return forwardToOffscreen("remove_task", { id, deleteFiles });
    }
    case "update_settings": {
      const updated = await forwardToOffscreen<Settings>("update_settings", req.payload);
      cachedSettings = updated;
      if (updated.standaloneMode) disconnectHelperNative();
      settingsInitialized = true;
      return updated;
    }
    default:
      return forwardToOffscreen(req.type, req.payload);
  }
}

function registerContextMenus(): void {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "tug-download-link",
      title: chrome.i18n.getMessage("ctxDownloadLink") || "使用 Tug Web 下载此链接",
      contexts: ["link"],
    });
    chrome.contextMenus.create({
      id: "tug-download-media",
      title: chrome.i18n.getMessage("ctxDownloadMedia") || "使用 Tug Web 下载此媒体",
      contexts: ["image", "video", "audio"],
    });
    chrome.contextMenus.create({
      id: "tug-download-selection",
      title: chrome.i18n.getMessage("ctxDownloadSelection") || "使用 Tug Web 下载选中链接/磁力",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "tug-open-manager",
      title: chrome.i18n.getMessage("ctxOpenManager") || "打开 Tug Web 下载管理面板",
      contexts: ["page", "action"],
    });
  });
}

async function handleTorrentUrlSmart(
  url: string,
  referrer?: string | null,
): Promise<{ startedDirectly: boolean }> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const meta = await parseTorrentBuffer(buf);
    if (meta.files.length <= 1) {
      await forwardToOffscreen<TaskView, AddTaskInput>("add_task", {
        url,
        referrer: referrer ?? null,
        fileName: meta.name,
        torrentBytesBase64: uint8ArrayToBase64(buf),
      });
      return { startedDirectly: true };
    }
  } catch {
    // 拉取/解析失败或包含多个文件时打开管理面板由用户确认
  }
  await openManagerTab(url);
  return { startedDirectly: false };
}

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "tug-open-manager") {
    await openManagerTab();
    return;
  }

  let candidateUrl: string | null = null;
  if (info.menuItemId === "tug-download-link" && info.linkUrl) {
    candidateUrl = info.linkUrl;
  } else if (info.menuItemId === "tug-download-media" && info.srcUrl) {
    candidateUrl = info.srcUrl;
  } else if (info.menuItemId === "tug-download-selection" && info.selectionText) {
    candidateUrl = extractDownloadCandidate(info.selectionText);
  }

  if (!candidateUrl) return;

  if (/^https?:\/\/.+\.torrent($|[?#])/i.test(candidateUrl)) {
    // 单文件种子直接下载，多文件种子打开管理面板让用户勾选确认
    await handleTorrentUrlSmart(candidateUrl, info.pageUrl || tab?.url || null);
    return;
  }

  try {
    await forwardToOffscreen<TaskView, AddTaskInput>("add_task", {
      url: candidateUrl,
      referrer: info.pageUrl || tab?.url || null,
    });
  } catch (err) {
    // 若直加失败（如非支持的 URL），打开管理面板引导用户确认
    await openManagerTab(candidateUrl);
    console.warn("[tug-web] Context menu add_task error:", err);
  }
});

// 监听并自动接管浏览器新下载
chrome.downloads?.onCreated.addListener(async (item) => {
  if (selfExportedDownloadIds.has(item.id)) {
    return;
  }
  // 忽略历史已完成的下载项（浏览器启动时可能重放）
  if (item.state && item.state !== "in_progress") {
    return;
  }

  const settings = await loadCachedSettings();
  const decision = shouldInterceptBrowserDownload(
    {
      url: item.url,
      finalUrl: item.finalUrl,
      filename: item.filename,
      mime: item.mime,
      totalBytes: item.totalBytes,
      byExtensionId: item.byExtensionId,
    },
    settings,
    chrome.runtime.id,
  );

  if (!decision.intercept) {
    return;
  }

  const targetUrl = item.finalUrl || item.url;
  const suggestedName = item.filename
    ? guessFileNameFromUrl(item.filename)
    : guessFileNameFromUrl(targetUrl);

  if (decision.reason === "torrent_file") {
    try {
      await handleTorrentUrlSmart(targetUrl, item.referrer || null);
      await chrome.downloads.cancel(item.id).catch(() => {});
      await chrome.downloads.erase({ id: item.id }).catch(() => {});
    } catch (err) {
      console.warn("[tug-web] Intercept .torrent fallback:", err);
    }
    return;
  }

  try {
    // 先在 Tug Web 创建任务，成功后再取消原浏览器下载，确保绝不丢失下载
    await forwardToOffscreen<TaskView, AddTaskInput>("add_task", {
      url: targetUrl,
      fileName: suggestedName !== "download" ? suggestedName : null,
      referrer: item.referrer || null,
    });

    await chrome.downloads.cancel(item.id).catch(() => {});
    await chrome.downloads.erase({ id: item.id }).catch(() => {});
  } catch (err) {
    console.warn("[tug-web] Intercept fallback to browser download:", err);
  }
});

// 监听 Offscreen 广播事件以更新扩展角标与发送完成通知
const notifiedTaskStates = new Map<number, string>();

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (
    !message ||
    typeof message !== "object" ||
    (message as ExtensionBroadcastMessage).channel !== "tug-web-event"
  ) {
    return;
  }

  const { event } = message as ExtensionBroadcastMessage;
  if (event.type === "settings") {
    cachedSettings = event.settings;
    if (event.settings.standaloneMode) disconnectHelperNative();
    settingsInitialized = true;
    return;
  }

  if (event.type === "updated") {
    const task = event.task;
    const prevState = notifiedTaskStates.get(task.id);
    notifiedTaskStates.set(task.id, task.state);

    if (
      cachedSettings.notifyOnComplete &&
      prevState &&
      prevState !== task.state &&
      (task.state === "completed" || task.state === "failed")
    ) {
      chrome.notifications?.create(`tug-task-${task.id}-${task.state}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
        title: t(task.state === "completed" ? "notification.completed" : "notification.failed"),
        message: task.error ? `${task.name} (${task.error})` : task.name,
      });
    }
  }

  // 更新工具栏图标上的活跃任务数角标
  void forwardToOffscreen<TaskView[]>("list_tasks")
    .then((tasks) => {
      const activeCount = tasks.filter(t => isActiveTaskState(t.state)).length;
      chrome.action?.setBadgeBackgroundColor({ color: "#676728" });
      chrome.action?.setBadgeText({
        text: activeCount > 0 ? String(activeCount) : "",
      });
    })
    .catch(() => {});
});

// 处理来自 Popup / Manager / Content Script / Offscreen 的 RPC 消息
chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse): boolean | undefined => {
    if (
      !message ||
      typeof message !== "object" ||
      (message as ExtensionRequest).channel !== "tug-web-rpc" ||
      (message as ExtensionRequest).target !== "background"
    ) {
      return undefined;
    }

    const req = message as ExtensionRequest;
    if (req.type === "get_agent_credentials" && (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("offscreen.html"))) {
      sendResponse({ ok: false, requestId: req.requestId, error: { code: "FORBIDDEN", message: "Offscreen credentials are private", retryable: false } });
      return;
    }
    handleBackgroundCommand(req)
      .then((data) => {
        const res: ExtensionResponse = {
          ok: true,
          requestId: req.requestId,
          data,
        };
        sendResponse(res);
      })
      .catch((err) => {
        const res: ExtensionResponse = {
          ok: false,
          requestId: req.requestId,
          error: {
            code: "BACKGROUND_ERROR",
            message: err instanceof Error ? err.message : String(err),
            retryable: true,
          },
        };
        sendResponse(res);
      });

    return true;
  },
);

chrome.runtime.onInstalled.addListener(() => {
  registerContextMenus();
  void ensureOffscreenDocument().catch(() => {});
  void loadCachedSettings(true).then((settings) => {
    if (!settings.standaloneMode) {
      void checkHelperHealth(500).then((st) => {
        if (st.available) void ensureExtIdRegisteredOnce();
      });
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  registerContextMenus();
  void ensureOffscreenDocument().catch(() => {});
  void loadCachedSettings(true).then((settings) => {
    if (!settings.standaloneMode) {
      void checkHelperHealth(500).then((st) => {
        if (st.available) void ensureExtIdRegisteredOnce();
      });
    }
  });
});

// 定时保活检查（当有活动任务时确保 Offscreen 宿主存活）
chrome.alarms?.create("tug-web-keepalive", { periodInMinutes: 0.4 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "tug-web-keepalive") {
    void ensureOffscreenDocument().catch(() => {});
    void loadCachedSettings().then((settings) => {
      if (!settings.standaloneMode && !extIdRegisteredInSession) {
        void checkHelperHealth(600).then((st) => {
          if (st.available) {
            void ensureExtIdRegisteredOnce();
          }
        });
      }
    });
  }
});
