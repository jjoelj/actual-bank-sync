function onMessage(type, handler) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type !== type) return;
        Promise.resolve()
            .then(() => handler(msg))
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    });
}

// ── Saved logins ─────────────────────────────────────────────────────────────
// Generic: the password field is found by a per-bank selector; the username is
// the first visible text-like input in the same form.

function loginFields(pwSel) {
    const pw = document.querySelector(pwSel);
    if (!pw) return {};
    const scope = pw.closest("form") || document;
    const user = [...scope.querySelectorAll('input[type=text], input[type=email], input[type=tel], input:not([type])')]
        .find(el => el !== pw && !el.matches(pwSel) && el.offsetParent !== null);
    return { pw, user, scope };
}

let autoLoginRunning = false;
let lastSavedPassword = null;

const usable = el => el && el.getClientRects().length > 0 && !el.disabled && !el.readOnly;

// Waits (by wall clock: timers are throttled in a minimized window) for the
// password field to be rendered, visible and enabled.
async function waitForUsablePassword(pwSel, ms = 10000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (usable(document.querySelector(pwSel))) return true;
        await new Promise(r => setTimeout(r, 250));
    }
    return false;
}

// Call once per bank content script. Serves the background's debugger-driven
// login (it types trusted keystrokes into whatever is focused), and saves
// logins the user submits by hand.
//   FOCUS_LOGIN_FIELD  {field} → {ok, hasValue}: focus + select the field
//   VERIFY_LOGIN_FIELD {field, value} → {matches}: did every keystroke land?
function registerLogin(bank, pwSel) {
    // Only the frame that has the password field answers, so in multi-frame
    // pages the reply comes from the login iframe; no frame answering rejects
    // the send.
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type !== "FOCUS_LOGIN_FIELD" && msg.type !== "VERIFY_LOGIN_FIELD") return;
        if (!document.querySelector(pwSel)) return;
        (async () => {
            if (!await waitForUsablePassword(pwSel)) return { ok: false, matches: false };
            const { pw, user, scope } = loginFields(pwSel);
            const el = msg.field === "password" ? pw
                : msg.field === "submit" ? [...scope.querySelectorAll('button[type=submit], input[type=submit], button:not([type])')].find(usable)
                : user;
            if (!usable(el)) return { ok: false, matches: false };   // e.g. no username box (remembered)
            if (msg.type === "VERIFY_LOGIN_FIELD") return { matches: el.value === msg.value };
            autoLoginRunning = true;
            el.focus();
            el.select?.();   // typing replaces anything already there (buttons have no select)
            // A remembered (often masked) username is reported so it's left alone.
            return { ok: document.activeElement === el, hasValue: !!el.value };
        })().then(sendResponse);
        return true;
    });
    captureLogins(bank, pwSel);
}

// Saves whatever the user submits by hand, so a changed password updates itself.
function captureLogins(bank, pwSel) {
    const save = () => {
        const { pw, user } = loginFields(pwSel);
        const password = pw?.value;
        if (!password || autoLoginRunning || password === lastSavedPassword) return;
        let username = user?.value.trim() || "";
        if (username.includes("*")) username = "";   // masked remembered username
        chrome.runtime.sendMessage({ type: "SAVE_LOGIN", bank, username, password }).catch(() => {});
        lastSavedPassword = password;   // don't save the same submit twice (click + submit events)
    };
    document.addEventListener("submit", save, true);
    document.addEventListener("click", e => { if (e.target.closest?.('button, input[type=submit]')) save(); }, true);
    document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches?.(pwSel)) save(); }, true);
}
