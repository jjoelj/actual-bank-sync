export const POLL_INTERVAL_MS = 3000;
export const POLL_TIMEOUT_MS = 2 * 60 * 1000;

import { sendToHost } from './host.js';

export async function importTransactions(label, settings, accountId, transactions) {
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

export function offsetDate(isoStr, days) {
    const d = new Date(isoStr);
    d.setDate(d.getDate() + days);
    return isoDate(d);
}

export function alreadySyncedToday(lastSyncDates, key) {
    return lastSyncDates[key] === offsetDate(isoDate(new Date()), -1);
}

export function getSyncPlan(lastSyncDates, syncFromDate, key, options = {}) {
    const endDate = offsetDate(isoDate(new Date()), -1);
    const forceDays = options.forceDays || 0;
    const isForced = forceDays > 0;

    if (isForced) {
        const startDate = offsetDate(endDate, -(forceDays - 1));
        return { startDate, endDate, isForced, shouldSync: true };
    }

    const startDate = lastSyncDates[key] || syncFromDate;
    if (!startDate) return null;

    return {
        startDate,
        endDate,
        isForced: false,
        shouldSync: !alreadySyncedToday(lastSyncDates, key),
    };
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

export async function updateLastSyncCount(key, count) {
    if (!count) return;
    const { lastSyncCounts = {} } = await chrome.storage.local.get("lastSyncCounts");
    lastSyncCounts[key] = count;
    await chrome.storage.local.set({ lastSyncCounts });
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
    }
    if (Object.keys(updates).length > 0) await chrome.storage.local.set(updates);
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
