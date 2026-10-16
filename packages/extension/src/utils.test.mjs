// Run: node src/utils.test.mjs
import assert from "node:assert";
import { refreshLastTxDates, getSyncPlan } from "./utils.js";

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
