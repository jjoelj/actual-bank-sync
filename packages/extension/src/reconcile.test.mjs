// Run: node src/reconcile.test.mjs
import assert from "node:assert";
import { compareAccount } from "./reconcile.js";

const row = (date, amount, payee, category, id) => ({
  date, amount, payee, category, id,
  key: `${date}|${amount}|${(payee || "Unknown").toLowerCase()}`,
});

// ── payee-divergent same date+amount pairs via the loose second pass ──────────
{
  // Same transaction, different payee formatting across apps + a whitespace diff
  // so even lowercased the exact keys differ.
  const sure = [row("2026-06-24", -1712, "JPLCAFE167RPC  QPS", "Food & Drink", "s1")];
  const actual = [row("2026-06-24", -1712, "Jplcafe167rpc Qps", "Food & Drink", "a1")];
  const r = compareAccount(sure, actual);
  assert.equal(r.matched, 1, "same date+amount pairs despite payee mismatch");
  assert.equal(r.missingInActual.length, 0);
  assert.equal(r.missingInSure.length, 0);
  assert.equal(r.mismatches.length, 0, "same category → no mismatch");
}

// ── category mismatch still reported on a loose-paired row ────────────────────
{
  const sure = [row("2026-06-24", -1712, "RAW CAPS", "Groceries", "s1")];
  const actual = [row("2026-06-24", -1712, "Raw Caps", "Dining", "a1")];
  const r = compareAccount(sure, actual);
  assert.equal(r.matched, 1);
  assert.equal(r.mismatches.length, 1, "categories differ → mismatch");
  assert.equal(r.mismatches[0].sureCategory, "Groceries");
  assert.equal(r.mismatches[0].actualCategory, "Dining");
}

// ── genuinely one-sided rows survive both passes ──────────────────────────────
{
  const sure = [row("2026-06-24", -500, "COFFEE", null, "s1")];
  const actual = [row("2026-06-25", -900, "Lunch", null, "a1")];
  const r = compareAccount(sure, actual);
  assert.equal(r.matched, 0);
  assert.deepEqual(r.missingInActual.map((x) => x.id), ["s1"]);
  assert.deepEqual(r.missingInSure.map((x) => x.id), ["a1"]);
}

// ── exact pass takes priority: two same date+amount rows pair by payee first ──
{
  // Sure has A,B; Actual has B,A (same date+amount, distinct payees). Exact pass
  // pairs A-A and B-B; nothing falls to the loose pass or one-sided.
  const sure = [row("2026-06-24", -1000, "STORE A", "X", "s1"), row("2026-06-24", -1000, "STORE B", "Y", "s2")];
  const actual = [row("2026-06-24", -1000, "Store B", "Y", "a2"), row("2026-06-24", -1000, "Store A", "X", "a1")];
  const r = compareAccount(sure, actual);
  assert.equal(r.matched, 2);
  assert.equal(r.mismatches.length, 0, "exact-payee pairing kept categories aligned");
}

console.log("reconcile: all assertions passed");
