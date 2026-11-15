import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { checkHelperHealth, helperRequestHeaders, setHelperCredentials, startHelperTorrentSession,
  exportBlobViaHelper, connectHelperNative, disconnectHelperNative, NATIVE_HELPER_BASE_URL } from "../src/engine/torrent/native-helper.ts";
import { normalizeSettings } from "../src/shared/types.ts";
const originalFetch = globalThis.fetch;
const originalChrome = globalThis.chrome;
afterEach(async () => { disconnectHelperNative(); globalThis.chrome = originalChrome; globalThis.fetch = originalFetch; await setHelperCredentials(null); });

it("sends Native Messaging capabilities only to the exact Agent origin", async () => {
  const token = "ab".repeat(32);
  await setHelperCredentials(token);
  assert.equal((await helperRequestHeaders(`${NATIVE_HELPER_BASE_URL}/webseed/1/file`)).get("x-tug-agent-token"), token);
  for (const url of ["https://seed.test/", "http://127.0.0.1:16900/", "http://127.0.0.1:16899@evil.test/"]) {
    assert.equal((await helperRequestHeaders(url)).has("x-tug-agent-token"), false);
  }
});
it("refuses an older unauthenticated Agent and clears stale credentials", async () => {
  globalThis.fetch = (async () => Response.json({ ok: true, service: "tug-agent", version: "1.0.0" })) as typeof fetch;
  assert.equal((await checkHelperHealth()).updateRequired, true);
  assert.equal((await checkHelperHealth()).available, false);
  await setHelperCredentials("ab".repeat(32));
  globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;
  await checkHelperHealth();
  await assert.rejects(helperRequestHeaders(NATIVE_HELPER_BASE_URL), /Agent 自动连接失败/);
});
it("authenticates session/export calls and disallows redirects carrying capabilities", async () => {
  const token = "cd".repeat(32);
  await setHelperCredentials(token);
  const calls: string[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push(String(url));
    assert.equal(new Headers(init?.headers).get("x-tug-agent-token"), token);
    assert.equal(init?.redirect, "error");
    return Response.json({ ok: true, sessionId: "1", savedPath: "Downloads/file.bin" });
  }) as typeof fetch;
  assert.equal((await startHelperTorrentSession({ url: "magnet:?xt=urn:btih:test" })).sessionId, "1");
  assert.equal(await exportBlobViaHelper(new Blob(["data"]), "file.bin"), "Downloads/file.bin");
  assert.equal(calls.length, 2);
});

it("preserves an explicitly empty Tracker list", () => {
  assert.deepEqual(normalizeSettings({ btCustomTrackers: [] }).btCustomTrackers, []);
});

function mockNative(event: "ready" | "old" | "error" | "silent") {
  const listeners: Array<(message: unknown) => void> = [];
  let connects = 0, disconnects = 0;
  const port = { onMessage: { addListener: (fn: (m: unknown) => void) => listeners.push(fn) },
    onDisconnect: { addListener: () => {} }, disconnect: () => { disconnects++; },
    postMessage: () => { if(event !== "silent") queueMicrotask(() => listeners.forEach(fn => fn(event === "ready"
      ? { ok: true, protocolVersion: 2, token: "ab".repeat(32) }
      : event === "old" ? { ok: true, type: "ready" } : { ok: false, message: "registration failed" }))); } };
  globalThis.chrome = { runtime: { id: "a".repeat(32), connectNative: () => { connects++; return port; } } } as unknown as typeof chrome;
  return { get connects() { return connects; }, get disconnects() { return disconnects; } };
}
it("distinguishes an installed Agent requiring pairing from a ready Agent", async () => {
  globalThis.fetch = (async () => Response.json({ ok: true, service: "tug-agent", protocolVersion: 2, authRequired: true })) as typeof fetch;
  const state = await checkHelperHealth();
  assert.equal(state.installed, true); assert.equal(state.pairingRequired, true); assert.equal(state.available, false);
});
it("shares native startup, persists credentials before health and retains the host connection", async () => {
  const native = mockNative("ready");
  globalThis.fetch = (async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("X-Tug-Agent-Token"), "ab".repeat(32));
    return Response.json({ ok: true, service: "tug-agent", protocolVersion: 2, authRequired: true });
  }) as typeof fetch;
  const [a,b] = await Promise.all([connectHelperNative(),connectHelperNative()]);
  assert.equal(a.available, true); assert.equal(b.available, true); assert.equal(native.connects,1); assert.equal(native.disconnects,0);
  disconnectHelperNative(); assert.equal(native.disconnects,1);
});
it("reports old hosts, explicit startup errors and handshake timeouts without leaking ports", async () => {
  for (const event of ["old","error","silent"] as const) {
    const native = mockNative(event); const status = await connectHelperNative(20);
    assert.equal(status.available,false); assert.equal(native.disconnects,1);
    if(event === "old") assert.equal(status.updateRequired,true);
    else assert.match(status.nativeError!, event === "error" ? /registration failed/ : /timed out/);
  }
});
it("preserves export failures and cancellation rather than silently exporting another copy", async () => {
  await setHelperCredentials("ab".repeat(32));
  globalThis.fetch = (async () => new Response("Disk full",{status:500})) as typeof fetch;
  await assert.rejects(exportBlobViaHelper(new Blob(["data"]),"file.bin"),/Disk full/);
  const controller = new AbortController();controller.abort(new Error("user paused"));
  globalThis.fetch = (async () => {throw new Error("aborted");}) as typeof fetch;
  await assert.rejects(exportBlobViaHelper(new Blob(["data"]),"file.bin",controller.signal),/user paused/);
});
it("retrieves Offscreen credentials silently and refreshes a rejected token once", async () => {
  let requests=0, posts=0;
  globalThis.chrome={runtime:{sendMessage:async(message: {type:string})=>{assert.equal(message.type,"get_agent_credentials");return {ok:true,data:{token:(++requests===1?"ab":"cd").repeat(32)}};}}} as unknown as typeof chrome;
  globalThis.fetch=(async (_url,init)=>{
    posts++;assert.equal(new Headers(init?.headers).get("X-Tug-Agent-Token"),(posts===1?"ab":"cd").repeat(32));
    return posts===1?new Response(null,{status:401}):Response.json({ok:true,savedPath:"Downloads/recovered.bin"});
  }) as typeof fetch;
  assert.equal(await exportBlobViaHelper(new Blob(["payload"]),"recovered.bin"),"Downloads/recovered.bin");assert.equal(posts,2);assert.equal(requests,2);
});
