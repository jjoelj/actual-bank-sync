// ── Native messaging ─────────────────────────────────────────────────────────

let nextRequestId = 1;

export function sendToHost(command, payload = {}) {
    return new Promise((resolve, reject) => {
        const port = chrome.runtime.connectNative("com.actual.banksync");
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
