import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { MessageKey } from "./zh-CN";
import { resolveLocale, type ResolvedLocale } from "./locales";
import { translate } from "./catalog";
export { resolveLocale, SUPPORTED_LOCALES, type ResolvedLocale } from "./locales";
export { getDictionary, translate } from "./catalog";

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
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
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
