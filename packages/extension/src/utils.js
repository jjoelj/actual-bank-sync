export const POLL_INTERVAL_MS = 500;
export const POLL_TIMEOUT_MS = 2 * 60 * 1000;

export function subtractOneDay(isoDate) {
    const [y, m, d] = isoDate.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

import { sendToHost } from './host.js';

export async function importTransactions(label, settings, accountId, transactions) {
    const cutoff = offsetDate(pacificDate(new Date()), -1);
    transactions = transactions.filter(tx => tx.date <= cutoff);

    const idCounts = new Map();
    const deduped = transactions.map(tx => {
        if (!tx.imported_id) return tx;
        const n = (idCounts.get(tx.imported_id) || 0) + 1;
        idCounts.set(tx.imported_id, n);
        return n > 1 ? { ...tx, imported_id: `${tx.imported_id}-${n}` } : tx;
    });

    const collisions = [...idCounts.values()].filter(n => n > 1).length;
    if (collisions) console.warn(`${label}: ${collisions} imported_id collision(s) resolved`);
    console.log(`${label}: imported_ids`, deduped.map(tx => tx.imported_id));

    const result = await sendToHost("importTransactions", { settings, accountId, transactions: deduped });
    const added = result?.added?.length ?? 0;
    const updated = result?.updated?.length ?? 0;
    const skipped = deduped.length - added - updated;
    console.log(`${label}: sent ${deduped.length}, added ${added}, updated ${updated}, skipped ${skipped}`);
    return result;
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

// Naive CSV line parser (handles quoted fields)
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

export function offsetDate(isoStr, days) {
    const [y, m, d] = isoStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function alreadySyncedToday(lastSyncDates, key) {
    return lastSyncDates[key] === offsetDate(pacificDate(new Date()), -1);
}

export function getSyncPlan(lastSyncDates, syncFromDate, key, options = {}) {
    const endDate = offsetDate(pacificDate(new Date()), -1);
    const startDate = lastSyncDates[key] || syncFromDate;
    if (!startDate) return null;

    return {
        startDate,
        endDate,
        shouldSync: !alreadySyncedToday(lastSyncDates, key),
    };
}

// accountBalance: what Actual should show right now — positive for checking, negative for credit.
// transactions: all fetched for this sync window (startDate → today Pacific).
// Invariant: startingBalance + cumulativeTxSum + todayTxSum == accountBalance
export async function verifyAndSaveStartingBalance(key, { transactions, accountBalance, isFirstSync, trackByIds }) {
    const todayStr = pacificDate(new Date());
    const endDate = offsetDate(todayStr, -1);

    const storageKeys = ["startingBalances", "cumulativeTxSums"];
    if (trackByIds) storageKeys.push("countedTxIds");
    else storageKeys.push("balanceCheckEndDates");

    const {
        startingBalances = {},
        cumulativeTxSums = {},
        countedTxIds = {},
        balanceCheckEndDates = {},
    } = await chrome.storage.local.get(storageKeys);

    const savedStartingBalance = startingBalances[key];
    const isNew = savedStartingBalance === undefined || isFirstSync;
    const prevCumulative = isNew ? 0 : (cumulativeTxSums[key] ?? 0);

    const todayTxSum = transactions
        .filter(tx => tx.date === todayStr)
        .reduce((s, tx) => s + tx.amount, 0);

    let newImportedTxSum;
    if (trackByIds) {
        const counted = new Set(isNew ? [] : (countedTxIds[key] ?? []));
        const newTxs = transactions.filter(tx => tx.date <= endDate && tx.imported_id && !counted.has(tx.imported_id));
        newImportedTxSum = newTxs.reduce((s, tx) => s + tx.amount, 0);
        for (const tx of newTxs) counted.add(tx.imported_id);
        countedTxIds[key] = [...counted];
    } else {
        const prevEndDate = isNew ? undefined : balanceCheckEndDates[key];
        newImportedTxSum = transactions
            .filter(tx => tx.date <= endDate && (prevEndDate === undefined || tx.date > prevEndDate))
            .reduce((s, tx) => s + tx.amount, 0);
        balanceCheckEndDates[key] = endDate;
    }

    const newCumulative = prevCumulative + newImportedTxSum;

    if (isNew) {
        const startingBalance = accountBalance - newImportedTxSum - todayTxSum;
        startingBalances[key] = startingBalance;
        cumulativeTxSums[key] = newCumulative;
        const save = { startingBalances, cumulativeTxSums };
        if (trackByIds) save.countedTxIds = countedTxIds;
        else save.balanceCheckEndDates = balanceCheckEndDates;
        await chrome.storage.local.set(save);
        return { isNew: true, isFirstSync, changed: false, startingBalance };
    }

    const drift = savedStartingBalance + newCumulative + todayTxSum - accountBalance;
    const changed = drift !== 0;

    if (changed) {
        const sign = drift > 0 ? "+" : "";
        console.warn(`Balance drift for ${key}: ${sign}$${(drift / 100).toFixed(2)}`);
        const { balanceDrifts = {} } = await chrome.storage.local.get("balanceDrifts");
        balanceDrifts[key] = { drift, at: Date.now() };
        await chrome.storage.local.set({ balanceDrifts });
        chrome.action.setBadgeText({ text: "!" });
        chrome.action.setBadgeBackgroundColor({ color: "#e53e3e" });
    }

    cumulativeTxSums[key] = newCumulative;
    const save = { cumulativeTxSums };
    if (trackByIds) save.countedTxIds = countedTxIds;
    else save.balanceCheckEndDates = balanceCheckEndDates;
    await chrome.storage.local.set(save);
    return { isNew: false, isFirstSync, changed };
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


export async function updateLastSyncDate(key, date) {
    const { lastSyncDates = {} } = await chrome.storage.local.get("lastSyncDates");
    lastSyncDates[key] = date;
    await chrome.storage.local.set({ lastSyncDates });
}

export async function updateLastSyncMetrics(key, transactions) {
    const { lastSyncMetrics = {}, activeSyncSessionId = null, activeSyncSummary = null } = await chrome.storage.local.get([
        "lastSyncMetrics",
        "activeSyncSessionId",
        "activeSyncSummary",
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
    } else if (!lastSyncMetrics[key]) {
        lastSyncMetrics[key] = metrics;
        updates.lastSyncMetrics = lastSyncMetrics;
    }
    if (Object.keys(updates).length > 0) await chrome.storage.local.set(updates);
}

export async function updateLastSyncStats(key, transactions) {
    await updateLastSyncMetrics(key, transactions);
}

// Calls verifyAndSaveStartingBalance and, on first sync, imports a synthetic starting balance transaction.
// accountBalance: what Actual should show right now (positive for checking/wallet, negative for credit).
// transactions: the transactions used for balance math (may be a subset of what was imported, e.g. wallet-only).
export async function applyStartingBalance(label, key, { settings, accountId, transactions, accountBalance, isFirstSync, startDate, importedId, trackByIds }) {
    const { startingBalance } = await verifyAndSaveStartingBalance(key, { transactions, accountBalance, isFirstSync, trackByIds });
    console.log(`${label}: accountBalance=${accountBalance}${isFirstSync ? ` startingBalance=${startingBalance}` : ""}`);
    if (isFirstSync && startingBalance !== 0) {
        const dayBefore = subtractOneDay(startDate);
        await importTransactions(`${label} Starting Balance`, settings, accountId, [{
            date: dayBefore,
            amount: startingBalance,
            payee_name: "Starting Balance",
            imported_id: importedId,
        }]);
        console.log(`${label}: imported starting balance ${startingBalance} on ${dayBefore}`);
    }
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
