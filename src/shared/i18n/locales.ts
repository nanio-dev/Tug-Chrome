export const SUPPORTED_LOCALES = ["zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR"] as const;
export type ResolvedLocale = typeof SUPPORTED_LOCALES[number];

export function resolveLocale(settingLocale?: string, browserLanguage?: string): ResolvedLocale {
  if (SUPPORTED_LOCALES.includes(settingLocale as ResolvedLocale)) return settingLocale as ResolvedLocale;
  const language = (browserLanguage ?? (typeof navigator !== "undefined" ? navigator.language : "en-US")).toLowerCase();
  if (language.startsWith("zh")) {
    const parts = language.split("-");
    return parts.includes("hant") || (!parts.includes("hans") && parts.some(p => ["tw", "hk", "mo"].includes(p))) ? "zh-TW" : "zh-CN";
  }
  if (language === "ja" || language.startsWith("ja-")) return "ja-JP";
  if (language === "ko" || language.startsWith("ko-")) return "ko-KR";
  return "en-US";
}
