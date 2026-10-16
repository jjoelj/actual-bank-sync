// Run: node src/utils.test.mjs
import assert from "node:assert";
import {
  pruneDeadMappings, refreshLastTxDates, getSyncPlan, quarterRange,
  recordBankCategories, offsetDate, pacificDate, spendRetentionStart, retainedQuarters,
  SPEND_RETENTION_QUARTERS,
} from "./utils.js";

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

// A pending backfill drags the window back past what the app holds, once.
store.backfillFrom = { "sofi-credit": "2026-02-01" };
await refreshLastTxDates({}, dates, maps, ["sofi-credit"]);
assert.equal(dates["sofi-credit"].sure, "2026-02-01", "backfill wins over the app's later date");
assert.deepEqual(store.backfillFrom, {}, "backfill is consumed, not repeated every sync");

await refreshLastTxDates({}, dates, maps, ["sofi-credit"]);
assert.equal(dates["sofi-credit"].sure, "2026-05-01", "next sync is back to the app's own date");

console.log("refreshLastTxDates: OK");

// Reward caps reset on calendar quarters — every month must land in the right
// one, and each quarter must end on its real last day (Q1 in a leap year too).
assert.deepEqual(quarterRange("2026-08-08"), { startDate: "2026-07-01", endDate: "2026-09-30", label: "Q3 2026" });
assert.deepEqual(quarterRange("2026-01-01"), { startDate: "2026-01-01", endDate: "2026-03-31", label: "Q1 2026" });
assert.deepEqual(quarterRange("2026-12-31"), { startDate: "2026-10-01", endDate: "2026-12-31", label: "Q4 2026" });
assert.equal(quarterRange("2024-02-29").endDate, "2024-03-31", "leap year Q1 still ends 03-31");
for (let m = 1; m <= 12; m++) {
  const r = quarterRange(`2026-${String(m).padStart(2, "0")}-15`);
  assert.ok(r.startDate <= `2026-${String(m).padStart(2, "0")}-15` && r.endDate >= `2026-${String(m).padStart(2, "0")}-15`, `month ${m} inside its quarter`);
}

console.log("quarterRange: OK");

// Retention must land on a quarter boundary — a mid-quarter cutoff would leave
// the oldest kept quarter partial, and its total silently short.
assert.equal(spendRetentionStart("2026-08-08"), "2025-10-01", "3 quarters back from Q3 2026");
assert.equal(spendRetentionStart("2026-01-15"), "2025-04-01", "crosses the year backwards");
assert.equal(spendRetentionStart("2026-12-31"), "2026-01-01", "Q4 keeps the whole year");
for (const d of ["2026-01-15", "2026-04-15", "2026-08-08", "2026-11-30", "2027-02-01"]) {
  const start = spendRetentionStart(d);
  assert.match(start, /-(01|04|07|10)-01$/, `${d} → ${start} is a quarter start`);
  const months = (Number(d.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + (Number(d.slice(5, 7)) - Number(start.slice(5, 7)));
  assert.equal(Math.floor(months / 3), SPEND_RETENTION_QUARTERS - 1, `${d} keeps exactly ${SPEND_RETENTION_QUARTERS} quarters`);
}

console.log("spendRetentionStart: OK");

// The quarter picker's options: newest first, contiguous, none repeated, and
// reaching back to exactly where retention starts.
const picker = retainedQuarters("2026-08-08");
assert.equal(picker.length, SPEND_RETENTION_QUARTERS);
assert.deepEqual(picker.map(q => q.label), ["Q3 2026", "Q2 2026", "Q1 2026", "Q4 2025"]);
assert.equal(picker.at(-1).startDate, spendRetentionStart("2026-08-08"), "oldest option is the retention floor");
for (let i = 1; i < picker.length; i++) {
  assert.equal(offsetDate(picker[i].endDate, 1), picker[i - 1].startDate, "quarters are contiguous, no gap");
}

console.log("retainedQuarters: OK");

// Raw bank categories: overlapping sync windows must overwrite, not double-count,
// or the cap total drifts up every re-sync. Dates are relative so the retention
// prune is exercised no matter when this runs.
const today = pacificDate(new Date());
const recent = offsetDate(today, -3);
const ancient = offsetDate(spendRetentionStart(today), -1); // one day outside retention

await recordBankCategories("usbank-1", [
  { date: recent,  category: "Fast Food", amount: -1250, imported_id: "usbank-a", payee_name: "TACO BELL" },
  { date: recent,  category: "Fast Food", amount: -2000, imported_id: "usbank-b", payee_name: "CHIPOTLE" },
  { date: ancient, category: "Fast Food", amount: -9900, imported_id: "usbank-old", payee_name: "OLD" },
  { date: recent,  amount: -500, imported_id: "usbank-nocat" }, // no category → not tracked
]);
await recordBankCategories("usbank-1", [
  { date: recent, category: "Fast Food", amount: -1250, imported_id: "usbank-a", payee_name: "TACO BELL" },
  { date: recent, category: "Gyms", amount: -5000, payee_name: "PLANET FITNESS" }, // no id → fingerprint
]);

const tracked = store.bankCategorySpend["usbank-1"];
assert.equal(Object.keys(tracked).length, 3, "re-sync overwrites; uncategorized skipped, expired pruned");
assert.ok(!("usbank-old" in tracked), "past the retention window is dropped");
assert.deepEqual(tracked["usbank-a"], [recent, "Fast Food", -1250, "TACO BELL"], "payee kept for drill-down");

const fastFood = Object.values(tracked)
  .filter(([, category]) => category === "Fast Food")
  .reduce((sum, [, , cents]) => sum - cents, 0);
assert.equal(fastFood, 3250, "$32.50 counted once, not twice");

console.log("recordBankCategories: OK");
