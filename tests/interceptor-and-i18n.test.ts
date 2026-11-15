import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  sanitizeFileName,
  shouldInterceptBrowserDownload,
} from "../src/shared/filename.ts";
import { enUS } from "../src/shared/i18n/en-US.ts";
import { zhCN } from "../src/shared/i18n/zh-CN.ts";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/shared/types.ts";

describe("Download Interceptor & Security / i18n Checks", () => {
  it("sanitizes dangerous file names, path traversal, and Windows reserved names", () => {
    assert.equal(sanitizeFileName("../../etc/passwd"), "passwd");
    assert.equal(sanitizeFileName("C:\\Windows\\System32\\cmd.exe"), "cmd.exe");
    assert.equal(sanitizeFileName("CON.txt"), "_CON.txt");
    assert.equal(sanitizeFileName("nul"), "_nul");
    assert.equal(sanitizeFileName('bad<>:"|?*name.zip'), "bad_______name.zip");
  });

  it("prevents infinite loops and respects size/domain/extension rules when intercepting downloads", () => {
    const settings = { ...DEFAULT_SETTINGS, minInterceptSizeMib: 5 };
    const selfId = "abcdefghijklmnopabcdefghijklmnop";

    // 1. 自身发起的导出下载绝不二次接管
    assert.equal(
      shouldInterceptBrowserDownload(
        {
          url: "https://example.com/big.iso",
          totalBytes: 100 * 1024 * 1024,
          byExtensionId: selfId,
        },
        settings,
        selfId,
      ).intercept,
      false,
    );

    // 2. blob: / data: / chrome-extension: 绝不接管
    assert.equal(
      shouldInterceptBrowserDownload(
        { url: "blob:https://example.com/1234-5678", totalBytes: 50 * 1024 * 1024 },
        settings,
        selfId,
      ).intercept,
      false,
    );

    // 3. 小于最小阈值 (5 MiB) 的普通文件放行给浏览器
    assert.equal(
      shouldInterceptBrowserDownload(
        { url: "https://example.com/small.zip", totalBytes: 1024 * 1024 },
        settings,
        selfId,
      ).intercept,
      false,
    );

    // 4. .torrent 种子文件即使体积很小也自动接管
    assert.equal(
      shouldInterceptBrowserDownload(
        { url: "https://example.com/ubuntu.torrent", totalBytes: 24 * 1024 },
        settings,
        selfId,
      ).intercept,
      true,
    );

    // 5. 大于阈值的正常下载自动接管
    assert.equal(
      shouldInterceptBrowserDownload(
        { url: "https://mirror.example.org/ubuntu-24.04.iso", totalBytes: 800 * 1024 * 1024 },
        settings,
        selfId,
      ).intercept,
      true,
    );
  });

  it("ensures zh-CN and en-US locale dictionaries have identical keys", () => {
    const zhKeys = Object.keys(zhCN).sort();
    const enKeys = Object.keys(enUS).sort();
    assert.deepEqual(zhKeys, enKeys);
  });

  it("normalizes standaloneMode setting cleanly", () => {
    assert.equal(DEFAULT_SETTINGS.standaloneMode, false);
    assert.equal(normalizeSettings({}).standaloneMode, false);
    assert.equal(normalizeSettings({ standaloneMode: true }).standaloneMode, true);
    assert.equal(
      normalizeSettings({ standaloneMode: "yes" as unknown as boolean }).standaloneMode,
      true,
    );
  });
});
