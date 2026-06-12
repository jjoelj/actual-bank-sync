export const POLL_INTERVAL_MS = 500;
export const POLL_TIMEOUT_MS = 2 * 60 * 1000;

export function subtractOneDay(isoDate) {
    const [y, m, d] = isoDate.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

import { createCsvImport, getTransactions, getLatestTransactionDate, getCategories, setTransactionCategory } from './sure.js';
import { sendToHost } from './host.js';
import { getBankForKey } from './accounts.js';

// ── App targets ──────────────────────────────────────────────────────────────
// A mapping value is { sure?: id, actual?: id } — each bank account can sync to
// Sure, Actual, or both. Legacy values (a bare Actual account id string) are
// normalized here and migrated in storage by migrateAccountMappings().

export function appTargets(mapping) {
    if (!mapping) return {};
    if (typeof mapping === "string") return { actual: mapping };
    return mapping;
}

export async function migrateAccountMappings() {
    const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");
    let changed = false;
    for (const [key, value] of Object.entries(accountMappings)) {
        if (typeof value === "string") {
            accountMappings[key] = { actual: value };
            changed = true;
        }
    }
    if (changed) await chrome.storage.local.set({ accountMappings });
}

// Logs, per configured app, the opening balance the app would need for its
// balance to line up with the bank: appBalances = { sure?, actual? } (cents,
// liability-negative), byApp = importTransactions result per app.
export function logBalanceDrift(label, appBalances, byApp, bankBalance) {
    for (const app of ["sure", "actual"]) {
        const appBalance = appBalances?.[app];
        if (appBalance == null) continue;
        const addedSum = byApp?.[app]?.addedSum ?? 0;
        const expected = appBalance + addedSum;
        const opening = bankBalance - expected;
        console.log(`${label} [${app}]: app ${appBalance} + added ${addedSum} = ${expected}, bank ${bankBalance}, opening balance needed: ${opening} ($${(opening / 100).toFixed(2)})`);
    }
}

// Sure only ever logs drift, but an Actual account needs an opening anchor: on
// an account's first sync, import a synthetic "Starting Balance" transaction
// dated the day before the sync window so Actual's balance matches the bank.
// Idempotent via imported_id. addedSumOverride lets banks whose balance covers
// only a subset of imported transactions (e.g. Venmo wallet) supply their own
// sum instead of the import result's.
export async function applyActualStartingBalance(label, settings, mapping, { bankBalance, appBalances, byApp, isFirstSync, startDate, importedId, addedSumOverride }) {
    const target = appTargets(mapping);
    if (!target.actual || !isFirstSync || bankBalance == null || !startDate) return;
    const actualBalance = appBalances?.actual;
    if (actualBalance == null) {
        console.warn(`${label}: no Actual balance available, skipping starting balance.`);
        return;
    }
    const addedSum = addedSumOverride ?? byApp?.actual?.addedSum ?? 0;
    const startingBalance = bankBalance - (actualBalance + addedSum);
    if (startingBalance === 0) return;
    const dayBefore = subtractOneDay(startDate);
    await importToActual(`${label} Starting Balance`, settings, target.actual, [{
        date: dayBefore,
        amount: startingBalance,
        payee_name: "Starting Balance",
        imported_id: importedId,
    }]);
    console.log(`${label}: imported Actual starting balance ${startingBalance} on ${dayBefore}`);
}

function sureToFingerprint(tx) {
    return `${tx.date}|${tx.signed_amount_cents}|${tx.name || ""}`;
}

function txFingerprint(tx) {
    return `${tx.date}|${tx.amount}|${tx.payee_name || "Unknown"}`;
}

// Category held-back queue fingerprint (includes raw category so two rows that
// differ only by category aren't collapsed).
function pendingFingerprint(tx) {
    return `${tx.date}|${tx.amount}|${tx.payee_name || "Unknown"}|${tx.category || ""}`;
}

// Split fetched transactions into ones we can import now and ones we hold back
// because their bank category hasn't been mapped to a budget category yet.
// Mapped categories are rewritten to the budget category name (or blank when
// mapped to ""), and uncategorized rows always import. Held-back rows are
// queued under their mapping key until flushPendingCategories() picks them up.
async function applyCategoryMappings(transactions, mappingKey) {
    const bank = getBankForKey(mappingKey);
    if (!bank) return { importable: transactions, heldBack: 0 };

    const { categoryMappings = {}, pendingCategoryTxns = {} } =
        await chrome.storage.local.get(["categoryMappings", "pendingCategoryTxns"]);
    const bankMap = categoryMappings[bank] || {};

    const importable = [];
    const newlyHeld = [];
    for (const tx of transactions) {
        const raw = tx.category;
        if (!raw) {
            importable.push(tx);
        } else if (Object.prototype.hasOwnProperty.call(bankMap, raw)) {
            importable.push({ ...tx, category: bankMap[raw] || undefined });
        } else {
            newlyHeld.push(tx);
        }
    }

    if (newlyHeld.length) {
        const queue = pendingCategoryTxns[mappingKey] || [];
        // Count what's already queued by fingerprint so a re-fetched transaction
        // isn't queued twice — matched 1:1 against the existing queue. Genuinely
        // identical same-day rows (two transactions sharing a fingerprint) are
        // both kept rather than collapsed, which a Set would do.
        const queuedCounts = new Map();
        for (const tx of queue) {
            const fp = pendingFingerprint(tx);
            queuedCounts.set(fp, (queuedCounts.get(fp) || 0) + 1);
        }
        for (const tx of newlyHeld) {
            const fp = pendingFingerprint(tx);
            const already = queuedCounts.get(fp) || 0;
            if (already > 0) {
                queuedCounts.set(fp, already - 1); // re-fetch of one already queued
            } else {
                queue.push({ ...tx });
            }
        }
        pendingCategoryTxns[mappingKey] = queue;
        await chrome.storage.local.set({ pendingCategoryTxns });
    }

    return { importable, heldBack: newlyHeld.length };
}

// ── Sure import path ─────────────────────────────────────────────────────────
// Sure's CSV import has no imported_id concept: dedup against what's in Sure by
// fingerprint, CSV-import the rest, then set categories per transaction.

async function importToSure(label, accountId, transactions, onProgress) {
    if (transactions.length === 0) return { added: 0, addedSum: 0 };

    let minDate = transactions[0].date, maxDate = transactions[0].date;
    for (const tx of transactions) {
        if (tx.date < minDate) minDate = tx.date;
        if (tx.date > maxDate) maxDate = tx.date;
    }

    const existing = await getTransactions(accountId, { startDate: minDate, endDate: maxDate });
    console.log(`${label}: ${existing.length} existing transactions in Sure (${minDate} → ${maxDate})`);
    const knownCounts = new Map();
    for (const tx of existing) {
        const fp = sureToFingerprint(tx);
        knownCounts.set(fp, (knownCounts.get(fp) || 0) + 1);
    }
    const newTxs = [];
    for (const tx of transactions) {
        const fp = txFingerprint(tx);
        const remaining = knownCounts.get(fp) || 0;
        if (remaining > 0) {
            knownCounts.set(fp, remaining - 1);
        } else {
            newTxs.push(tx);
        }
    }

    if (newTxs.length === 0) {
        console.log(`${label}: all ${transactions.length} transactions already in Sure, skipping.`);
        return { added: 0, addedSum: 0 };
    }

    onProgress?.(0, `Uploading ${newTxs.length} to Sure`);
    await createCsvImport(accountId, newTxs);
    await new Promise(r => setTimeout(r, 5000));
    // Categorizing is the slow part (one PATCH per transaction): give it the
    // back half of the upload phase so its per-transaction progress is visible.
    await applyCategories(label, accountId, newTxs, minDate, maxDate, onProgress && ((f, m) => onProgress(0.5 + f * 0.5, m)));
    const addedSum = newTxs.reduce((sum, tx) => sum + tx.amount, 0);
    const skipped = transactions.length - newTxs.length;
    console.log(`${label}: ${transactions.length} total, ${newTxs.length} new via CSV import, ${skipped} already in Sure`);
    return { added: newTxs.length, addedSum };
}

// The CSV import API silently drops the category column, so categories are set
// per transaction afterward via PATCH. Matches each just-imported categorized
// row to its Sure transaction by fingerprint and assigns the resolved category
// only when that transaction is still uncategorized — so categories are set on
// first import and re-syncs never overwrite changes made on the Sure end.
async function applyCategories(label, accountId, importedTxs, minDate, maxDate, onProgress) {
    const categorized = importedTxs.filter(t => t.category);
    if (categorized.length === 0) return;

    let idByName;
    try {
        const cats = await getCategories();
        idByName = new Map(cats.map(c => [c.name, c.id]));
    } catch (err) {
        console.warn(`${label}: could not load categories, skipping category assignment:`, err.message);
        return;
    }

    const current = await getTransactions(accountId, { startDate: minDate, endDate: maxDate });
    const byFp = new Map();
    for (const tx of current) {
        const fp = sureToFingerprint(tx);
        if (!byFp.has(fp)) byFp.set(fp, []);
        byFp.get(fp).push(tx);
    }

    let applied = 0;
    for (let i = 0; i < categorized.length; i++) {
        const tx = categorized[i];
        onProgress?.(i / categorized.length, `Categorizing ${i + 1}/${categorized.length}`);
        const categoryId = idByName.get(tx.category);
        if (!categoryId) {
            console.warn(`${label}: no Sure category named "${tx.category}", leaving uncategorized.`);
            continue;
        }
        const candidates = byFp.get(txFingerprint(tx)) || [];
        // Only assign to a still-uncategorized transaction; never overwrite a
        // category already set in Sure (rules, manual edits, an earlier import).
        const idx = candidates.findIndex(c => !c.category);
        if (idx < 0) continue;
        const match = candidates.splice(idx, 1)[0];
        try {
            await setTransactionCategory(match.id, categoryId);
            applied++;
        } catch (err) {
            console.warn(`${label}: failed to set category on ${match.id}:`, err.message);
        }
    }
    if (applied) console.log(`${label}: set category on ${applied} transaction(s).`);
}

// ── Actual import path ───────────────────────────────────────────────────────
// Actual dedups natively by imported_id; the worker resolves category names to
// Actual category ids and reports the summed amount of what was actually added.

async function importToActual(label, settings, accountId, transactions, onProgress) {
    if (transactions.length === 0) return { added: 0, addedSum: 0 };

    const idCounts = new Map();
    const deduped = transactions.map(tx => {
        if (!tx.imported_id) return tx;
        const n = (idCounts.get(tx.imported_id) || 0) + 1;
        idCounts.set(tx.imported_id, n);
        return n > 1 ? { ...tx, imported_id: `${tx.imported_id}-${n}` } : tx;
    });

    const collisions = [...idCounts.values()].filter(n => n > 1).length;
    if (collisions) console.warn(`${label}: ${collisions} imported_id collision(s) resolved`);

    onProgress?.(0, `Uploading ${deduped.length} to Actual`);
    const result = await sendToHost("importTransactions", { settings, accountId, transactions: deduped });
    const added = result?.added?.length ?? 0;
    const updated = result?.updated?.length ?? 0;
    console.log(`${label}: sent ${deduped.length} to Actual, added ${added}, updated ${updated}, skipped ${deduped.length - added - updated}`);
    return { added, addedSum: result?.addedSum ?? 0 };
}

// Import transactions whose categories are already finalized (budget category
// names or blank) into every app the mapping targets.
async function importResolved(label, settings, target, transactions, onProgress) {
    const byApp = {};
    if (transactions.length > 0) {
        const apps = [target.sure && "sure", target.actual && "actual"].filter(Boolean);
        for (let i = 0; i < apps.length; i++) {
            const app = apps[i];
            const base = i / apps.length, span = 1 / apps.length;
            const sub = onProgress && ((f, m) => onProgress(base + f * span, m));
            byApp[app] = app === "sure"
                ? await importToSure(`${label} [sure]`, target.sure, transactions, sub)
                : await importToActual(`${label} [actual]`, settings, target.actual, transactions, sub);
        }
    }
    const added = Math.max(0, ...Object.values(byApp).map(r => r.added));
    return { added, byApp };
}

export async function importTransactions(label, settings, mapping, transactions, mappingKey, onProgress) {
    const target = appTargets(mapping);
    if (!target.sure && !target.actual) return { added: 0, byApp: {} };
    if (transactions.length === 0) return { added: 0, byApp: {} };

    const { importable, heldBack } = await applyCategoryMappings(transactions, mappingKey);
    if (heldBack > 0) {
        console.log(`${label}: holding back ${heldBack} transaction(s) with unmapped categories.`);
    }
    return importResolved(label, settings, target, importable, onProgress);
}

// Import queued transactions whose bank category has since been mapped. Runs
// without a bank tab — it only translates categories and posts to the apps.
// Returns the number of transactions imported. onProgress(key, fraction,
// message) reports per-account upload progress; a null message signals done.
export async function flushPendingCategories(settings, targetKeys, onProgress) {
    const { categoryMappings = {}, pendingCategoryTxns = {}, accountMappings = {} } =
        await chrome.storage.local.get(["categoryMappings", "pendingCategoryTxns", "accountMappings"]);

    const keys = targetKeys?.length ? targetKeys : Object.keys(pendingCategoryTxns);
    let totalAdded = 0;
    let changed = false;

    for (const key of keys) {
        const queue = pendingCategoryTxns[key];
        if (!queue?.length) continue;
        const target = appTargets(accountMappings[key]);
        if (!target.sure && !target.actual) continue;
        const bankMap = categoryMappings[getBankForKey(key)] || {};

        const ready = [];
        const remaining = [];
        for (const tx of queue) {
            if (Object.prototype.hasOwnProperty.call(bankMap, tx.category)) {
                ready.push({ ...tx, category: bankMap[tx.category] || undefined });
            } else {
                remaining.push(tx);
            }
        }

        if (ready.length) {
            console.log(`Flush ${key}: importing ${ready.length} previously held transaction(s).`);
            onProgress?.(key, 0, `Importing ${ready.length} mapped`);
            try {
                const { added } = await importResolved(`Flush ${key}`, settings, target, ready, onProgress && ((f, m) => onProgress(key, f, m)));
                totalAdded += added;
            } finally {
                onProgress?.(key, null, null); // clear the row's progress when done
            }
            pendingCategoryTxns[key] = remaining;
            changed = true;
        }
    }

    if (changed) await chrome.storage.local.set({ pendingCategoryTxns });
    return { added: totalAdded };
}

export function getDateChunks(startDate, endDate, maxDays) {
    const chunks = [];
    let current = new Date(startDate);
    const end = new Date(endDate);

    while (current < end) {
        const chunkEnd = new Date(current);
        chunkEnd.setDate(chunkEnd.getDate() + maxDays);
        if (chunkEnd > end) chunkEnd.setTime(end.getTime());
        chunks.push([isoDate(current), isoDate(chunkEnd)]);
        current = new Date(chunkEnd);
        current.setDate(current.getDate() + 1);
    }

    return chunks;
}

export function parseCsvLine(line) {
    const result = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (ch === "," && !inQuotes) {
            result.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    result.push(current);
    return result;
}

// ── Date helpers ─────────────────────────────────────────────────────────────

export function isoDate(date) {
    return date.toISOString().split("T")[0];
}

export function pacificDate(date) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(date);
}

export function toLocalDate(timestamp) {
    if (timestamp == null) return null;
    if (typeof timestamp === "number") {
        const d = new Date(timestamp);
        return Number.isNaN(d.getTime()) ? null : pacificDate(d);
    }
    const str = String(timestamp);
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    const parsed = new Date(str);
    if (Number.isNaN(parsed.getTime())) return null;
    return pacificDate(parsed);
}

export function offsetDate(isoStr, days) {
    const [y, m, d] = isoStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Seed each key's sync watermark from the apps themselves: the earliest of the
// mapped apps' latest-transaction dates, so neither app misses the gap between
// its own last import and the other's.
export async function seedLastTxDates(settings, lastTxDates, accountMappings, keys) {
    let updated = false;
    for (const key of keys) {
        if (lastTxDates[key]) continue;
        const target = appTargets(accountMappings[key]);
        const dates = [];
        if (target.sure) {
            try {
                const date = await getLatestTransactionDate(target.sure);
                if (date) dates.push(date);
            } catch (err) {
                console.warn(`Failed to seed lastTxDate for ${key} from Sure:`, err.message);
            }
        }
        if (target.actual) {
            try {
                const date = await sendToHost("getLatestTransactionDate", { settings, accountId: target.actual });
                if (date) dates.push(date);
            } catch (err) {
                console.warn(`Failed to seed lastTxDate for ${key} from Actual:`, err.message);
            }
        }
        if (dates.length) {
            lastTxDates[key] = dates.reduce((a, b) => (a < b ? a : b));
            updated = true;
        }
    }
    if (updated) await chrome.storage.local.set({ lastTxDates });
}

export function getSyncPlan(lastSyncDates, syncFromDate, key, lastTxDates = {}) {
    const endDate = pacificDate(new Date());
    const startDate = lastTxDates[key] || lastSyncDates[key] || syncFromDate;
    if (!startDate) return null;

    return { startDate, endDate };
}

export function reportProgress(options, ...args) {
    if (typeof options.onProgress === "function") {
        options.onProgress(...args);
    }
}

// ── Tab helpers ──────────────────────────────────────────────────────────────

export function openTabBackground(url) {
    return new Promise((resolve, reject) => {
        chrome.windows.create({ url, type: "normal", width: 1200, height: 800 }, (win) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(win.tabs[0]);
            }
        });
    });
}

export function onTabClose(tabId, onClose) {
    function listener(removedTabId) {
        if (removedTabId === tabId) {
            chrome.tabs.onRemoved.removeListener(listener);
            onClose();
        }
    }
    chrome.tabs.onRemoved.addListener(listener);
    return () => chrome.tabs.onRemoved.removeListener(listener);
}


export async function updateLastSyncDate(key, date) {
    const { lastSyncDates = {} } = await chrome.storage.local.get("lastSyncDates");
    lastSyncDates[key] = date;
    await chrome.storage.local.set({ lastSyncDates });
}

export async function updateLastSyncMetrics(key, transactions) {
    const { lastSyncMetrics = {}, activeSyncSessionId = null, activeSyncSummary = null, lastTxDates = {} } = await chrome.storage.local.get([
        "lastSyncMetrics",
        "activeSyncSessionId",
        "activeSyncSummary",
        "lastTxDates",
    ]);

    const metrics = {
        count: transactions.length,
        inflow: 0,
        outflow: 0,
        net: 0,
        sessionId: activeSyncSessionId,
    };

    for (const tx of transactions) {
        const amount = Number(tx.amount) || 0;
        metrics.net += amount;
        if (amount > 0) metrics.inflow += amount;
        if (amount < 0) metrics.outflow += Math.abs(amount);
    }

    const nextSummary = activeSyncSessionId
        ? updateSyncSummary(activeSyncSummary, activeSyncSessionId, key, metrics)
        : activeSyncSummary;

    const updates = { ...(nextSummary ? { activeSyncSummary: nextSummary } : {}) };
    if (transactions.length > 0) {
        lastSyncMetrics[key] = metrics;
        updates.lastSyncMetrics = lastSyncMetrics;

        let maxDate = transactions[0].date;
        for (const tx of transactions) {
            if (tx.date > maxDate) maxDate = tx.date;
        }
        lastTxDates[key] = maxDate;
        updates.lastTxDates = lastTxDates;
    } else if (!lastSyncMetrics[key]) {
        lastSyncMetrics[key] = metrics;
        updates.lastSyncMetrics = lastSyncMetrics;
    }
    if (Object.keys(updates).length > 0) await chrome.storage.local.set(updates);
}

export async function updateLastSyncStats(key, transactions) {
    await updateLastSyncMetrics(key, transactions);
}

function updateSyncSummary(summary, sessionId, key, metrics) {
    const byKey = {
        ...((summary?.sessionId === sessionId && summary?.byKey) ? summary.byKey : {}),
        [key]: metrics,
    };
    const values = Object.values(byKey);

    return {
        sessionId,
        byKey,
        syncedAccounts: values.length,
        transactionCount: values.reduce((sum, item) => sum + (item.count || 0), 0),
        inflow: values.reduce((sum, item) => sum + (item.inflow || 0), 0),
        outflow: values.reduce((sum, item) => sum + (item.outflow || 0), 0),
    };
}
