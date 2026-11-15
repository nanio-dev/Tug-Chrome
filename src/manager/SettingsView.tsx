import { useEffect, useState, type FormEvent } from "react";
import {
  activateNativeHelperProtocol,
  ensureNativeHelper,
  getNativeHelperStatus,
} from "../shared/client";
import { useI18n } from "../shared/i18n";
import type { NativeHelperStatus } from "../shared/protocol";
import { DEFAULT_SETTINGS, type AppInfo, type Settings } from "../shared/types";

export type SettingsTab = "download" | "network" | "bt" | "appearance" | "about";

export function SettingsView({
  settings,
  info,
  onSave,
}: {
  settings: Settings;
  info: AppInfo | null;
  onSave: (next: Partial<Settings>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<SettingsTab>("download");
  const [draft, setDraft] = useState<Settings>(() => structuredClone(settings));
  const [domainsText, setDomainsText] = useState(() =>
    settings.excludedDomains.join(", "),
  );
  const [extsText, setExtsText] = useState(() =>
    settings.excludedExtensions.join(", "),
  );
  const [trackersText, setTrackersText] = useState(() =>
    settings.btCustomTrackers.join("\n"),
  );
  const [savedToast, setSavedToast] = useState(false);
  const [helperStatus, setHelperStatus] = useState<NativeHelperStatus>({
    available: false,
  });
  const [wakingHelper, setWakingHelper] = useState(false);

  useEffect(() => {
    setDraft(structuredClone(settings));
    setDomainsText(settings.excludedDomains.join(", "));
    setExtsText(settings.excludedExtensions.join(", "));
    setTrackersText(settings.btCustomTrackers.join("\n"));
  }, [settings]);

  useEffect(() => {
    if (settings.standaloneMode || draft.standaloneMode) {
      setHelperStatus({ available: false, standaloneMode: true });
      return;
    }
    void getNativeHelperStatus()
      .then((st) => setHelperStatus(st))
      .catch(() => {});
  }, [tab, settings.standaloneMode, draft.standaloneMode]);

  const handleWakeHelper = async () => {
    if (draft.standaloneMode) return;
    setWakingHelper(true);
    try {
      let st = await ensureNativeHelper(false);
      if (!st.available) {
        st = await activateNativeHelperProtocol();
      }
      setHelperStatus(st);
    } finally {
      setWakingHelper(false);
    }
  };

  const renderStandaloneModeToggle = () => (
    <label className="check-row">
      <input
        type="checkbox"
        checked={draft.standaloneMode}
        onChange={(e) =>
          setDraft({
            ...draft,
            standaloneMode: e.target.checked,
          })
        }
      />
      <span>
        <b>{t("settings.standaloneMode")}</b>
        <em>{t("settings.standaloneModeHint")}</em>
      </span>
    </label>
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Settings = {
      ...draft,
      excludedDomains: domainsText
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      excludedExtensions: extsText
        .split(/[\n,]+/)
        .map((s) => s.trim().replace(/^\./, ""))
        .filter(Boolean),
      btCustomTrackers: trackersText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
    await onSave(next);
    setSavedToast(true);
    setTimeout(() => setSavedToast(false), 2200);
  };

  const handleReset = async () => {
    setDraft(structuredClone(DEFAULT_SETTINGS));
    setDomainsText(DEFAULT_SETTINGS.excludedDomains.join(", "));
    setExtsText(DEFAULT_SETTINGS.excludedExtensions.join(", "));
    setTrackersText(DEFAULT_SETTINGS.btCustomTrackers.join("\n"));
    await onSave(DEFAULT_SETTINGS);
    setSavedToast(true);
    setTimeout(() => setSavedToast(false), 2200);
  };

  return (
    <form className="settings-layout" onSubmit={handleSubmit}>
      <div className="subnav">
        {(
          [
            ["download", t("settings.tab.download")],
            ["network", t("settings.tab.network")],
            ["bt", t("settings.tab.bt")],
            ["appearance", t("settings.tab.appearance")],
            ["about", t("settings.tab.about")],
          ] as Array<[SettingsTab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`subnav-item ${tab === key ? "active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div>
        {tab === "download" && (
          <div className="form-card">
            <div className="form-card-head">
              <h3>{t("settings.tab.download")}</h3>
            </div>
            <div className="form-card-body">
              <div className="field-row">
                <div className="field">
                  <label>{t("settings.downloadSubdir")}</label>
                  <input
                    type="text"
                    value={draft.downloadSubdir}
                    onChange={(e) =>
                      setDraft({ ...draft, downloadSubdir: e.target.value })
                    }
                    placeholder=""
                  />
                  <span className="hint">{t("settings.downloadSubdirHint")}</span>
                </div>

                <div className="field">
                  <label>{t("settings.minSize")}</label>
                  <input
                    type="number"
                    min={0}
                    max={10240}
                    step={0.5}
                    value={draft.minInterceptSizeMib}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        minInterceptSizeMib: Number(e.target.value),
                      })
                    }
                  />
                  <span className="hint">{t("settings.minSizeHint")}</span>
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label>{t("settings.connections")}</label>
                  <input
                    type="number"
                    min={1}
                    max={32}
                    value={draft.connectionsPerTask}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        connectionsPerTask: Number(e.target.value),
                      })
                    }
                  />
                </div>

                <div className="field">
                  <label>{t("settings.concurrent")}</label>
                  <input
                    type="number"
                    min={1}
                    max={16}
                    value={draft.maxConcurrentTasks}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        maxConcurrentTasks: Number(e.target.value),
                      })
                    }
                  />
                </div>
              </div>

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={draft.autoInterceptDownloads}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      autoInterceptDownloads: e.target.checked,
                    })
                  }
                />
                <span>
                  <b>{t("settings.autoIntercept")}</b>
                  <em>{t("settings.autoInterceptHint")}</em>
                </span>
              </label>

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={draft.interceptMagnetLinks}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      interceptMagnetLinks: e.target.checked,
                    })
                  }
                />
                <span>
                  <b>{t("settings.interceptMagnet")}</b>
                </span>
              </label>

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={draft.interceptTorrentFiles}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      interceptTorrentFiles: e.target.checked,
                    })
                  }
                />
                <span>
                  <b>{t("settings.interceptTorrent")}</b>
                </span>
              </label>

              {renderStandaloneModeToggle()}

              <div className="field">
                <label>{t("settings.excludedDomains")}</label>
                <input
                  type="text"
                  value={domainsText}
                  onChange={(e) => setDomainsText(e.target.value)}
                />
              </div>

              <div className="field">
                <label>{t("settings.excludedExtensions")}</label>
                <input
                  type="text"
                  value={extsText}
                  onChange={(e) => setExtsText(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}

        {tab === "network" && (
          <div className="form-card">
            <div className="form-card-head">
              <h3>{t("settings.tab.network")}</h3>
            </div>
            <div className="form-card-body">
              <div className="field">
                <label>{t("settings.globalLimit")}</label>
                <input
                  type="number"
                  min={0}
                  value={draft.globalDownloadLimitKib ?? ""}
                  placeholder={t("settings.globalLimitHint")}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      globalDownloadLimitKib: e.target.value
                        ? Number(e.target.value)
                        : null,
                    })
                  }
                />
                <span className="hint">{t("settings.globalLimitHint")}</span>
              </div>

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={draft.carryCookies}
                  onChange={(e) =>
                    setDraft({ ...draft, carryCookies: e.target.checked })
                  }
                />
                <span>
                  <b>{t("settings.carryCookies")}</b>
                  <em>{t("settings.carryCookiesHint")}</em>
                </span>
              </label>

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={draft.carryReferer}
                  onChange={(e) =>
                    setDraft({ ...draft, carryReferer: e.target.checked })
                  }
                />
                <span>
                  <b>{t("settings.carryReferer")}</b>
                  <em>{t("settings.carryRefererHint")}</em>
                </span>
              </label>

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={draft.notifyOnComplete}
                  onChange={(e) =>
                    setDraft({ ...draft, notifyOnComplete: e.target.checked })
                  }
                />
                <span>
                  <b>{t("settings.notify")}</b>
                </span>
              </label>
            </div>
          </div>
        )}

        {tab === "bt" && (
          <div className="form-card">
            <div className="form-card-head">
              <h3>{t("settings.tab.bt")}</h3>
            </div>
            <div className="form-card-body">
              {renderStandaloneModeToggle()}

              <div
                className="side-storage"
                style={{
                  marginTop: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "12px",
                  opacity: draft.standaloneMode ? 0.65 : 1,
                }}
              >
                <div>
                  <div className="side-storage-label" style={{ fontWeight: 700 }}>
                    {t("settings.btHelperTitle")}
                  </div>
                  <div className="side-storage-path" style={{ marginTop: "4px" }}>
                    {draft.standaloneMode
                      ? t("sidebar.helperDisabled")
                      : helperStatus.available
                        ? t("settings.btHelperOnline", {
                            port: helperStatus.port ?? 16899,
                          })
                        : t("settings.btHelperStandby")}
                  </div>
                  <div className="hint" style={{ marginTop: "4px" }}>
                    {t("settings.btHelperDesc")}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn"
                  disabled={wakingHelper || draft.standaloneMode}
                  onClick={() => void handleWakeHelper()}
                >
                  {draft.standaloneMode
                    ? t("sidebar.helperDisabled")
                    : wakingHelper
                      ? t("settings.btHelperWaking")
                      : t("settings.btHelperWakeBtn")}
                </button>
              </div>

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={draft.btWebRtcEnabled}
                  onChange={(e) =>
                    setDraft({ ...draft, btWebRtcEnabled: e.target.checked })
                  }
                />
                <span>
                  <b>{t("settings.btWebRtc")}</b>
                </span>
              </label>

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={draft.btWebSeedEnabled}
                  onChange={(e) =>
                    setDraft({ ...draft, btWebSeedEnabled: e.target.checked })
                  }
                />
                <span>
                  <b>{t("settings.btWebSeed")}</b>
                </span>
              </label>

              <div className="field">
                <label>{t("settings.btTrackers")}</label>
                <textarea
                  rows={5}
                  className="mono"
                  value={trackersText}
                  onChange={(e) => setTrackersText(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}

        {tab === "appearance" && (
          <div className="form-card">
            <div className="form-card-head">
              <h3>{t("settings.tab.appearance")}</h3>
            </div>
            <div className="form-card-body">
              <div className="field-row">
                <div className="field">
                  <label>{t("settings.theme")}</label>
                  <select
                    value={draft.theme}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        theme: e.target.value as Settings["theme"],
                      })
                    }
                  >
                    <option value="system">{t("settings.theme.system")}</option>
                    <option value="light">{t("settings.theme.light")}</option>
                    <option value="dark">{t("settings.theme.dark")}</option>
                  </select>
                </div>

                <div className="field">
                  <label>{t("settings.language")}</label>
                  <select
                    value={draft.locale}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        locale: e.target.value as Settings["locale"],
                      })
                    }
                  >
                    <option value="system">{t("settings.language.system")}</option>
                    <option value="zh-CN">{t("settings.language.zh")}</option>
                    <option value="en-US">{t("settings.language.en")}</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === "about" && (
          <div className="form-card">
            <div className="form-card-head">
              <h3>{t("settings.tab.about")}</h3>
            </div>
            <div className="form-card-body">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <div className="side-storage" style={{ marginTop: 0 }}>
                  <div className="side-storage-label">VERSION</div>
                  <div className="side-storage-path">{info?.version ?? "1.0.0"} (MV3)</div>
                </div>
                <div className="side-storage" style={{ marginTop: 0 }}>
                  <div className="side-storage-label">STORAGE ENGINE</div>
                  <div className="side-storage-path">{info?.storageEngine ?? "OPFS"} + IndexedDB</div>
                </div>
              </div>
              <div className="hint">
                Apache License 2.0 · Tug Family (Tug Desktop · Tug Android · Tug Web)
              </div>
            </div>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <button type="submit" className="btn btn-primary">
            {t("settings.save")}
          </button>
          <button type="button" className="btn" onClick={() => void handleReset()}>
            {t("settings.reset")}
          </button>
          {savedToast && <span className="ok" style={{ fontSize: "12px", fontWeight: 600 }}>{t("settings.saved")}</span>}
        </div>
      </div>
    </form>
  );
}
