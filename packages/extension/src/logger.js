// Captures service-worker console output into a ring buffer in chrome.storage.local
// and broadcasts each entry to the popup, so logs can be viewed without opening
// the service worker DevTools.

export const LOG_BUFFER_KEY = "logBuffer";
const MAX_LOG_ENTRIES = 1000;

let seq = 0;
let buffer = null;        // in-memory mirror of the stored ring buffer
let loadPromise = null;
let pending = [];         // entries not yet written to storage
let writing = false;      // true while the drain loop owns the write

function ensureLoaded() {
  if (buffer) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = chrome.storage.local.get(LOG_BUFFER_KEY).then((r) => {
      buffer = r[LOG_BUFFER_KEY] || [];
    });
  }
  return loadPromise;
}

function formatArg(arg) {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

// Drains `pending` into storage without a timer: each storage round-trip picks
// up whatever accumulated while the previous write was in flight, so entries are
// coalesced without a setTimeout that service-worker suspension could skip.
async function flush() {
  if (writing) return;
  writing = true;
  try {
    await ensureLoaded();
    while (pending.length) {
      const batch = pending;
      pending = [];
      buffer.push(...batch);
      if (buffer.length > MAX_LOG_ENTRIES) {
        buffer.splice(0, buffer.length - MAX_LOG_ENTRIES);
      }
      await chrome.storage.local.set({ [LOG_BUFFER_KEY]: buffer });
    }
  } finally {
    writing = false;
  }
}

function record(level, args) {
  const entry = {
    id: `${Date.now()}-${seq++}`,
    t: Date.now(),
    level,
    msg: args.map(formatArg).join(" "),
  };
  chrome.runtime.sendMessage({ type: "LOG_ENTRY", entry }).catch(() => {});
  pending.push(entry);
  flush();
}

let installed = false;

export function installLogCapture() {
  if (installed) return;
  installed = true;
  for (const level of ["log", "warn", "error"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      try {
        record(level, args);
      } catch {
        // never let logging break the caller
      }
    };
  }
}

export async function clearLogBuffer() {
  buffer = [];
  pending = [];
  await chrome.storage.local.set({ [LOG_BUFFER_KEY]: [] });
}
