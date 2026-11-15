import { createContext, useContext, useMemo, type ReactNode } from "react";
import { zhCN, type MessageKey, type Messages } from "./zh-CN";
import { enUS } from "./en-US";

export type ResolvedLocale = "zh-CN" | "en-US";

export function resolveLocale(settingLocale: string | undefined): ResolvedLocale {
  if (settingLocale === "zh-CN" || settingLocale === "en-US") {
    return settingLocale;
  }
  const navLang =
    typeof navigator !== "undefined" ? (navigator.language || "zh-CN").toLowerCase() : "zh-cn";
  if (navLang.startsWith("zh")) {
    return "zh-CN";
  }
  return "en-US";
}

export function getDictionary(locale: ResolvedLocale): Messages {
  return locale === "en-US" ? enUS : zhCN;
}

export function translate(
  locale: ResolvedLocale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const dict = getDictionary(locale);
  let template = dict[key] ?? zhCN[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      template = template.replaceAll(`{${k}}`, String(v));
    }
  }
  return template;
}

interface I18nContextValue {
  locale: ResolvedLocale;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: "zh-CN",
  t: (key, params) => translate("zh-CN", key, params),
});

export function I18nProvider({
  localeSetting,
  children,
}: {
  localeSetting?: string;
  children: ReactNode;
}) {
  const locale = resolveLocale(localeSetting);
  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      t: (key, params) => translate(locale, key, params),
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
