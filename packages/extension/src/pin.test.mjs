// PIN-locked saved logins: run with `node src/pin.test.mjs`. Fakes chrome.storage
// and a host whose "DPAPI" is the identity.
import assert from "node:assert";
const area = () => { const d = {}; return {
  get: async (k) => (typeof k === "string" ? { [k]: d[k] } : { ...d }),
  set: async (o) => Object.assign(d, o),
  remove: async (ks) => [].concat(ks).forEach((k) => delete d[k]), d }; };
const local = area(), session = area();
globalThis.chrome = { storage: { local, session }, runtime: { connectNative: () => { let l; return {
  onMessage: { addListener: (f) => (l = f) }, onDisconnect: { addListener() {} }, disconnect() {},
  postMessage: (m) => queueMicrotask(() => l({ result: m.command === "protect" ? m.text : m.blob })) }; } } };
const h = await import("./host.js");
// legacy plaintext login migrates when the PIN is first set
local.d.savedLogins = { sofi: JSON.stringify({ username: "u", password: "p" }) };
assert.deepEqual(await h.loadLogin("sofi"), { username: "u", password: "p" });
assert.equal(await h.unlockWithPin("1234"), true);
assert.ok(JSON.parse(local.d.savedLogins.sofi).ct, "migrated");
assert.deepEqual(await h.loadLogin("sofi"), { username: "u", password: "p" });
// new browser session: locked until the right PIN
delete session.d.pinKey;
await assert.rejects(h.loadLogin("sofi"), /PIN/);
assert.equal(await h.unlockWithPin("9999"), false);
assert.equal(await h.unlockWithPin("1234"), true);
assert.deepEqual(await h.loadLogin("sofi"), { username: "u", password: "p" });
await h.resetPin();
assert.equal(await h.hasPin(), false);
console.log("ok");
