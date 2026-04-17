export const POLL_INTERVAL_MS = 3000;
export const POLL_TIMEOUT_MS = 2 * 60 * 1000;

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

// ── Tab helpers ──────────────────────────────────────────────────────────────

export function openTabBackground(url) {
    return new Promise((resolve, reject) => {
        chrome.tabs.create({ url, active: false }, (tab) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(tab);
            }
        });
    });
}


export async function updateLastSyncDate(key, date) {
    const { lastSyncDates = {} } = await chrome.storage.local.get("lastSyncDates");
    lastSyncDates[key] = date;
    await chrome.storage.local.set({ lastSyncDates });
}
