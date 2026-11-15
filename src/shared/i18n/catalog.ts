import { zhCN, type MessageKey, type Messages } from "./zh-CN";
import { zhTW } from "./zh-TW";
import { enUS } from "./en-US";
import { jaJP } from "./ja-JP";
import { koKR } from "./ko-KR";
import type { ResolvedLocale } from "./locales";

const dictionaries: Record<ResolvedLocale, Messages> = { "zh-CN": zhCN, "zh-TW": zhTW, "en-US": enUS, "ja-JP": jaJP, "ko-KR": koKR };

export function getDictionary(locale: ResolvedLocale): Messages { return dictionaries[locale]; }

export function translate(locale: ResolvedLocale, key: MessageKey, params?: Record<string, string | number>): string {
  const template = dictionaries[locale][key] ?? enUS[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => params?.[name] === undefined ? match : String(params[name]));
}
