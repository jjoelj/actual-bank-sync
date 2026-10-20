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
    // hostProgress holds the host's interim status (e.g. updating the Actual
    // API) so any open popup can show it; cleared however the call ends.
    const result = queue.then(() => sendToHostNow(command, payload))
        .finally(() => chrome.storage.local.remove("hostProgress"));
    queue = result.catch(() => {}); // a failed call must not break the chain
    return result;
}

function sendToHostNow(command, payload = {}) {
    return new Promise((resolve, reject) => {
        const port = chrome.runtime.connectNative("com.github.jjoelj.actualbanksync");
        const id = nextRequestId++;

        port.onMessage.addListener((msg) => {
            if (msg.progress) {
                chrome.storage.local.set({ hostProgress: msg.progress });
                return;
            }
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

// ── Saved bank logins ────────────────────────────────────────────────────────
// Each login is AES-GCM encrypted under a key derived from the user's PIN, then
// DPAPI-wrapped by the host. The PIN is never stored; only the derived key is
// held in chrome.storage.session (memory, cleared when the browser closes).
// pinVault { salt, check } in local storage lets a typed PIN be verified.
// ponytail: a short numeric PIN only slows an attacker who already has the
// DPAPI-decrypted blob; a longer passphrase is the upgrade if that matters.

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const aesKey = (raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

async function deriveRaw(pin, salt) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
    return crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" }, base, 256);
}

async function seal(key, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
    return { iv: b64(iv), ct: b64(ct) };
}

async function unseal(key, { iv, ct }) {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct)));
}

async function sessionKey() {
    const { pinKey } = await chrome.storage.session.get("pinKey");
    return pinKey ? aesKey(unb64(pinKey)) : null;
}

export async function isUnlocked() {
    return Boolean(await sessionKey());
}

export async function hasPin() {
    return Boolean((await chrome.storage.local.get("pinVault")).pinVault);
}

// Verifies the PIN (or sets it, the first time) and holds its key for this
// browser session. Returns false on a wrong PIN.
export async function unlockWithPin(pin) {
    const { pinVault } = await chrome.storage.local.get("pinVault");
    if (pinVault) {
        const raw = await deriveRaw(pin, unb64(pinVault.salt));
        try {
            await unseal(await aesKey(raw), pinVault.check);
        } catch {
            return false;
        }
        await chrome.storage.session.set({ pinKey: b64(raw) });
        return true;
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const raw = await deriveRaw(pin, salt);
    await chrome.storage.local.set({ pinVault: { salt: b64(salt), check: await seal(await aesKey(raw), "ok") } });
    await chrome.storage.session.set({ pinKey: b64(raw) });
    // Logins saved before the PIN existed are DPAPI-only; re-save them under it.
    const { savedLogins = {} } = await chrome.storage.local.get("savedLogins");
    for (const bank of Object.keys(savedLogins)) {
        const login = await loadLogin(bank).catch(() => null);
        if (login) await saveLogin(bank, login);
    }
    return true;
}

// Forgotten PIN: the logins are unrecoverable without it, so drop them all.
export async function resetPin() {
    await chrome.storage.local.remove(["pinVault", "savedLogins"]);
    await chrome.storage.session.remove("pinKey");
}

export async function saveLogin(bank, login) {
    const key = await sessionKey();
    if (!key) throw new Error("PIN not entered this session");
    const blob = await sendToHost("protect", { text: JSON.stringify(await seal(key, JSON.stringify(login))) });
    const { savedLogins = {} } = await chrome.storage.local.get("savedLogins");
    await chrome.storage.local.set({ savedLogins: { ...savedLogins, [bank]: blob } });
}

export async function loadLogin(bank) {
    const { savedLogins = {} } = await chrome.storage.local.get("savedLogins");
    if (!savedLogins[bank]) return null;
    const inner = JSON.parse(await sendToHost("unprotect", { blob: savedLogins[bank] }));
    if (!inner.ct) return inner;   // pre-PIN login, until the PIN is first set
    const key = await sessionKey();
    if (!key) throw new Error("PIN not entered this session");
    return JSON.parse(await unseal(key, inner));
}
