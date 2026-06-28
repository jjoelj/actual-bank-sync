// ── Native messaging ─────────────────────────────────────────────────────────

let nextRequestId = 1;

// Each connectNative() launches a fresh host process, and every process opens
// the SAME Actual budget directory. Two running at once race on the budget's
// SQLite files — on Windows that surfaces as `EPERM ... My-Finances-*`. Serialize
// so only one host process touches the budget at a time.
// ponytail: global FIFO queue; fine for a single popup. Per-budget queues only
// if multiple budgets ever run concurrently.
let queue = Promise.resolve();

export function sendToHost(command, payload = {}) {
    const result = queue.then(() => sendToHostNow(command, payload));
    queue = result.catch(() => {}); // a failed call must not break the chain
    return result;
}

function sendToHostNow(command, payload = {}) {
    return new Promise((resolve, reject) => {
        const port = chrome.runtime.connectNative("com.github.jjoelj.actualbanksync");
        const id = nextRequestId++;

        port.onMessage.addListener((msg) => {
            port.disconnect();
            if (msg.error) reject(new Error(msg.error));
            else resolve(msg.result);
        });

        port.onDisconnect.addListener(() => {
            reject(new Error(chrome.runtime.lastError?.message || "Native host disconnected"));
        });

        try {
            port.postMessage({ id, command, ...payload });
        } catch (err) {
            reject(err);
        }
    });
}
