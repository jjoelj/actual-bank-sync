// Run: node src/utils.test.mjs
import assert from "node:assert";
import { pruneDeadMappings, refreshLastTxDates, getSyncPlan } from "./utils.js";

const mappings = {
  "bilt-credit":    { sure: "s1", actual: "dead" },   // actual gone, sure stays
  "target-credit":  { actual: "dead2" },              // only app → key removed
  "venmo-cash":     { actual: "a1" },                 // still live → untouched
  "sofi-credit":    { sure: "s2" },                   // not mapped to actual
  "usbank-1":       "dead3",                          // legacy string mapping
};
const lastTxDates = {
  "bilt-credit":   { sure: "2026-07-01", actual: "2026-07-02" },
  "target-credit": { actual: "2026-06-01" },
  "venmo-cash":    { actual: "2026-05-01" },
  "usbank-1":      "2026-04-01",                      // legacy shared watermark
};

const dropped = pruneDeadMappings(mappings, lastTxDates, "actual", new Set(["a1", "s1"]));

assert.deepEqual(dropped.sort(), ["bilt-credit", "target-credit", "usbank-1"]);
assert.deepEqual(mappings["bilt-credit"], { sure: "s1" }, "other app survives");
assert.ok(!("target-credit" in mappings), "last app dropped → key removed");
assert.deepEqual(mappings["venmo-cash"], { actual: "a1" }, "live id untouched");
assert.deepEqual(mappings["sofi-credit"], { sure: "s2" }, "unrelated app untouched");
assert.ok(!("usbank-1" in mappings), "legacy string mapping dropped");

assert.deepEqual(lastTxDates["bilt-credit"], { sure: "2026-07-01" }, "dead app's watermark cleared");
assert.deepEqual(lastTxDates["venmo-cash"], { actual: "2026-05-01" }, "live watermark kept");
assert.equal(lastTxDates["usbank-1"], "2026-04-01", "legacy string watermark left alone");

assert.deepEqual(pruneDeadMappings({}, {}, "sure", new Set()), [], "no mappings → nothing dropped");

// An empty fetched list never wipes mappings.
const kept = { "bilt-credit": { actual: "dead" } };
assert.deepEqual(pruneDeadMappings(kept, {}, "actual", new Set()), [], "empty list → no wipe");
assert.deepEqual(kept, { "bilt-credit": { actual: "dead" } });

console.log("pruneDeadMappings: OK");

// Deleting transactions in the app must pull the watermark (and the sync window)
// back — a stored date is never trusted over what the app actually reports.
const store = {};
globalThis.chrome = {
  storage: {
    sync: { get: async () => ({ sureApiKey: "k", sureUrl: "https://sure.test" }) },
    local: {
      get: async (keys) => {
        const names = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
        return Object.fromEntries(names.filter(n => n in store).map(n => [n, store[n]]));
      },
      set: async (obj) => { Object.assign(store, obj); },
    },
  },
};
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    transactions: [{ id: "t1", date: "2026-05-01" }, { id: "t2", date: "2026-06-15", classification: "transfer" }],
    pagination: { total_pages: 1, total_count: 2 },
  }),
});

const maps = { "sofi-credit": { sure: "s1" } };
const dates = { "sofi-credit": { sure: "2026-08-01" } }; // stale: rows since deleted
await refreshLastTxDates({}, dates, maps, ["sofi-credit"]);

assert.equal(dates["sofi-credit"].sure, "2026-05-01", "watermark rolls back to what Sure reports (transfer ignored)");
assert.equal(store.lastTxDates["sofi-credit"].sure, "2026-05-01", "rolled-back watermark is persisted");
assert.equal(getSyncPlan({}, "2020-01-01", "sofi-credit", dates, maps["sofi-credit"]).startDate, "2026-05-01");

console.log("refreshLastTxDates: OK");
