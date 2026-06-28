// ── Reconcile (Sure ↔ Actual) ─────────────────────────────────────────────────
// Audits accounts mapped to BOTH apps: pairs each app's transactions by the same
// fingerprint the sync uses (date | signed-cents | payee, lowercased) and reports
//   • category mismatches  — matched pairs whose category names differ
//   • one-sided rows       — exist in one app but not the other
// There is no shared transaction id across the apps, so matching is heuristic on
// those three fields. Transfers are excluded (each app creates its own transfer
// pair, so they never line up 1:1 and would only add noise) and counted instead.

import * as sure from "./sure.js";
import { sendToHost } from "./host.js";
import { appTargets, pacificDate } from "./utils.js";

// Identical to the sync dedup fingerprint: Sure uses signed_amount_cents + name,
// Actual uses amount + imported_payee — both reduce to this canonical key.
function fingerprint(date, cents, payee) {
  return `${date}|${cents}|${(payee || "Unknown").toLowerCase()}`;
}

// Sign- and payee-agnostic key for transfer exclusion. A card payment is a
// transfer one app pairs and the other often imports as a plain transaction,
// with a flipped sign and a reworded payee — so the only fields that still line
// up across both legs are the date and the absolute amount.
function looseKey(date, cents) {
  return `${date}|${Math.abs(Number(cents) || 0)}`;
}

// "", null, undefined and whitespace all mean uncategorized; anything else is a
// trimmed category name compared as-is across apps (mappings keep names aligned).
function normCategory(name) {
  const trimmed = (name ?? "").trim();
  return trimmed || null;
}

function sureCategoryName(tx) {
  if (tx.category && typeof tx.category === "object") return tx.category.name ?? null;
  if (typeof tx.category === "string") return tx.category;
  return tx.category_name ?? null;
}

function sureIsTransfer(tx) {
  return Boolean(tx.transfer) || tx.classification === "transfer";
}

// Group normalized rows by fingerprint so duplicates (genuinely identical
// same-day rows) are paired 1:1 rather than collapsed.
function groupByKey(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const list = byKey.get(row.key);
    if (list) list.push(row);
    else byKey.set(row.key, [row]);
  }
  return byKey;
}

// Diagnostic: when rows go unmatched, find how many WOULD match if we relaxed
// one field at a time — this points straight at the culprit (a broken amount, a
// renamed payee, a shifted date) instead of leaving every row looking unique.
// `sureLeft`/`actualLeft` are the unmatched rows; `sureAll`/`actualAll` are the
// full filtered lists. For each unmatched row we list what the OTHER app holds
// on the same date and at the same amount — so a row the user can "see in both"
// reveals which field (payee/amount/date) actually diverged, or confirms the
// other app truly lacks it.
function diagnoseUnmatched(label, sureLeft, actualLeft, sureAll, actualAll) {
  if (!sureLeft.length && !actualLeft.length) return;
  console.log(`Reconcile ${label}: ${sureLeft.length} unmatched in Sure, ${actualLeft.length} in Actual.`);

  const describe = (rows) => rows.map((r) => `"${r.payee}" ${r.amount}`).join(", ") || "(none)";
  const onDate = (rows, date) => rows.filter((r) => r.date === date);
  const onAmount = (rows, amount, date) => rows.filter((r) => r.amount === amount && r.date !== date);

  for (const s of sureLeft.slice(0, 10)) {
    console.log(`  Sure-only ${s.date} ${s.amount} "${s.payee}" | Actual same date: [${describe(onDate(actualAll, s.date))}] | Actual same amount other dates: [${describe(onAmount(actualAll, s.amount, s.date)).slice(0, 200)}]`);
  }
  for (const a of actualLeft.slice(0, 10)) {
    console.log(`  Actual-only ${a.date} ${a.amount} "${a.payee}" | Sure same date: [${describe(onDate(sureAll, a.date))}] | Sure same amount other dates: [${describe(onAmount(sureAll, a.amount, a.date)).slice(0, 200)}]`);
  }
}

function compareAccount(sureRows, actualRows) {
  const sureByKey = groupByKey(sureRows);
  const actualByKey = groupByKey(actualRows);

  const mismatches = [];
  const missingInActual = []; // in Sure, not Actual
  const missingInSure = [];   // in Actual, not Sure
  let matched = 0;

  for (const key of new Set([...sureByKey.keys(), ...actualByKey.keys()])) {
    const s = sureByKey.get(key) || [];
    const a = actualByKey.get(key) || [];
    const paired = Math.min(s.length, a.length);
    matched += paired;

    for (let i = 0; i < paired; i++) {
      if (normCategory(s[i].category) !== normCategory(a[i].category)) {
        mismatches.push({
          key: s[i].key,
          date: s[i].date,
          amount: s[i].amount,
          payee: s[i].payee || a[i].payee,
          sureCategory: normCategory(s[i].category),
          actualCategory: normCategory(a[i].category),
          sureId: s[i].id,
          actualId: a[i].id,
        });
      }
    }
    for (let i = paired; i < s.length; i++) missingInActual.push(s[i]);
    for (let i = paired; i < a.length; i++) missingInSure.push(a[i]);
  }

  const byDateDesc = (x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0);
  mismatches.sort(byDateDesc);
  missingInActual.sort(byDateDesc);
  missingInSure.sort(byDateDesc);
  return { matched, mismatches, missingInActual, missingInSure };
}

// Compare every dual-mapped account. Single-app and unmapped accounts are
// reported as `skipped` (nothing to compare). `range` is the window both sides
// are fetched over — defaults to syncFromDate → today. `onAccount` (optional) is
// called with each account's result as it finishes, so the UI can populate
// incrementally instead of waiting for the whole run.
export async function reconcileAll(settings, accountMappings, range = {}, onAccount) {
  const today = pacificDate(new Date());
  const startDate = range.startDate || "1970-01-01";
  const endDate = range.endDate || today;

  // Account display names and the Actual category id→name map are fetched once.
  // Actual calls go through a fresh worker each time, all sharing one dataDir, so
  // they must run one at a time — only the Sure (HTTP) call overlaps them.
  const sureAccountsP = sure.getAccounts().catch(() => []);
  const actualAccounts = await sendToHost("getAccounts", { settings }).catch(() => []);
  const actualCategories = await sendToHost("getCategories", { settings }).catch(() => []);
  const sureAccounts = await sureAccountsP;
  const sureName = new Map(sureAccounts.map((x) => [x.id, x.name]));
  const actualName = new Map(actualAccounts.map((x) => [x.id, x.name]));
  const actualCatName = new Map(actualCategories.map((c) => [c.id, c.name]));

  const accounts = [];
  const skipped = [];

  for (const [key, mapping] of Object.entries(accountMappings)) {
    const target = appTargets(mapping);
    if (!target.sure || !target.actual) {
      const only = target.sure ? "Sure" : target.actual ? "Actual" : null;
      skipped.push({ key, reason: only ? `mapped to ${only} only` : "not mapped" });
      continue;
    }

    let account;
    try {
      const [sureRaw, actualRaw] = await Promise.all([
        sure.getTransactions(target.sure, { startDate, endDate }),
        sendToHost("getTransactions", { settings, accountId: target.actual, startDate, endDate }),
      ]);

      // Normalize both sides first, tagging each app's own transfers.
      // Slice dates to 10 chars: Sure may return datetime strings like
      // "2024-01-15T00:00:00Z" while Actual returns "2024-01-15"; without
      // this the fingerprints never match even for the same calendar day.
      const sureNorm = sureRaw.map((tx) => ({
        id: tx.id,
        date: (tx.date || "").slice(0, 10),
        amount: tx.signed_amount_cents,
        payee: tx.name,
        category: sureCategoryName(tx),
        isTransfer: sureIsTransfer(tx),
      }));
      const actualNorm = actualRaw.map((tx) => ({
        id: tx.id,
        date: (tx.date || "").slice(0, 10),
        amount: tx.amount,
        // Bank modules set payee_name, not imported_payee; fall back so the
        // fingerprint never collapses to "Unknown" on the Actual side.
        payee: tx.imported_payee || tx.payee_name,
        category: tx.category ? (actualCatName.get(tx.category) ?? null) : null,
        isTransfer: Boolean(tx.transfer_id),
      }));

      // A transfer that one app pairs but the other imported as a plain
      // transaction must still be dropped from both sides, or its surviving leg
      // shows as a phantom one-sided row. Collect the loose keys of every
      // transfer from either app and exclude matches on both.
      const transferKeys = new Set();
      for (const r of [...sureNorm, ...actualNorm]) {
        if (r.isTransfer) transferKeys.add(looseKey(r.date, r.amount));
      }
      const isTransferRow = (r) => r.isTransfer || transferKeys.has(looseKey(r.date, r.amount));

      let sureTransfers = 0;
      const sureRows = [];
      for (const r of sureNorm) {
        if (isTransferRow(r)) { sureTransfers++; continue; }
        sureRows.push({ ...r, key: fingerprint(r.date, r.amount, r.payee) });
      }

      let actualTransfers = 0;
      const actualRows = [];
      for (const r of actualNorm) {
        if (isTransferRow(r)) { actualTransfers++; continue; }
        actualRows.push({ ...r, key: fingerprint(r.date, r.amount, r.payee) });
      }

      const result = compareAccount(sureRows, actualRows);
      diagnoseUnmatched(sureName.get(target.sure) || key, result.missingInActual, result.missingInSure, sureRows, actualRows);
      account = {
        key,
        sureAccount: sureName.get(target.sure) || target.sure,
        actualAccount: actualName.get(target.actual) || target.actual,
        counts: { sure: sureRows.length, actual: actualRows.length, matched: result.matched },
        transfers: { sure: sureTransfers, actual: actualTransfers },
        mismatches: result.mismatches,
        missingInActual: result.missingInActual,
        missingInSure: result.missingInSure,
      };
    } catch (err) {
      account = {
        key,
        sureAccount: sureName.get(target.sure) || target.sure,
        actualAccount: actualName.get(target.actual) || target.actual,
        error: err.message,
      };
    }

    accounts.push(account);
    if (onAccount) { try { onAccount(account); } catch {} }
  }

  return { accounts, skipped, range: { startDate, endDate } };
}
