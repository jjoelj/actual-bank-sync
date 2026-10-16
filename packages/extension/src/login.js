import { loadLogin } from "./host.js";

// Logs in with the saved login using trusted input: keystrokes go through the
// DevTools protocol, so the page sees isTrusted keydown/keyup events with
// human-ish timing, and Enter submits (no synthetic click). The bank's content
// script must call registerLogin() so FOCUS_LOGIN_FIELD can focus each field.
// Edge shows a "debugging this browser" bar while attached (a few seconds).
// Resolves false when there's nothing saved or it couldn't type; the caller
// falls back to a manual login.
// submit: "enter" (default) presses Enter in the password field; "space"
// focuses the submit button and presses Space, for forms Enter won't submit (Target).
export async function autoLogin(tabId, bank, { submit = "enter" } = {}) {
    const login = await loadLogin(bank).catch(err => {
        console.warn(`${bank}: couldn't load saved login:`, err.message);
        return null;
    });
    if (!login) {
        console.log(`${bank}: no saved login; log in by hand once to save it`);
        return false;
    }

    const target = { tabId };
    try {
        await chrome.debugger.attach(target, "1.3");
    } catch (err) {
        console.warn(`${bank}: couldn't attach debugger (DevTools open on the tab?):`, err.message);
        return false;
    }
    const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
    try {
        // The sync tab is in the background; make it behave as focused so it accepts input.
        await send("Emulation.setFocusEmulationEnabled", { enabled: true });
        // A window created minimized has no real size, so responsive pages lay
        // out narrow and can hide the sign-in box (Wells Fargo's homepage).
        // Lay out at desktop size while signing in; cleared on detach.
        await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 0, mobile: false });

        // The content script waits for the field to be usable before focusing.
        // No username field (or a remembered one) → just the password.
        const user = await askWhenReady(tabId, { type: "FOCUS_LOGIN_FIELD", field: "username" });
        if (user.ok && !user.hasValue && login.username) {
            await typeInto(tabId, send, "username", login.username);
            await jitter(300, 800);
        }
        await typeInto(tabId, send, "password", login.password);
        await jitter(300, 700);
        if (submit === "space") {
            // A focused button activated by Space fires a trusted click with no
            // pointer position, so it works in a minimized window and in iframes.
            if (!(await ask(tabId, { type: "FOCUS_LOGIN_FIELD", field: "submit" })).ok) throw new Error("couldn't find the submit button");
            await jitter(150, 300);
            await pressKey(send, { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
        } else {
            // Re-focus so Enter can't land elsewhere (select-all doesn't change the value).
            if (!(await ask(tabId, { type: "FOCUS_LOGIN_FIELD", field: "password" })).ok) throw new Error("lost the password field before submitting");
            await pressKey(send, { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
        }
        console.log(`${bank}: submitted saved login`);
        // Stay attached until the page navigates (≤10s): detaching ends focus
        // emulation, and a submit handler that does async work first (Target)
        // stalls once the minimized page goes back to unfocused.
        const { url: before } = await chrome.tabs.get(tabId);
        for (const deadline = Date.now() + 10000; Date.now() < deadline; await jitter(250, 250)) {
            const t = await chrome.tabs.get(tabId);
            if (t.status === "loading" || t.url !== before) break;
        }
        return true;
    } catch (err) {
        console.warn(`${bank}: auto-login failed:`, err.message);
        return false;
    } finally {
        await chrome.debugger.detach(target).catch(() => {});
    }
}

// Rejects when no frame has the login form (the content script stays silent).
const ask = (tabId, msg) => chrome.tabs.sendMessage(tabId, msg);

// The login iframe's content script loads at document_idle, possibly after the
// sync saw the password field; keep asking until it's there.
async function askWhenReady(tabId, msg, ms = 15000) {
    const deadline = Date.now() + ms;
    for (;;) {
        try {
            return await ask(tabId, msg);
        } catch (err) {
            if (Date.now() > deadline) throw err;
            await jitter(400, 600);
        }
    }
}

// Types into the field, then checks every keystroke landed. One retype on a
// mismatch; still wrong → throw, so a mangled password is never submitted
// (a failed attempt would count toward the bank's lockout).
async function typeInto(tabId, send, field, text) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        if (!(await ask(tabId, { type: "FOCUS_LOGIN_FIELD", field })).ok) throw new Error(`couldn't focus the ${field} field`);
        await jitter(200, 500);
        await typeText(send, text);
        if ((await ask(tabId, { type: "VERIFY_LOGIN_FIELD", field, value: text })).matches) return;
        console.warn(`${field} field didn't take every keystroke (attempt ${attempt})`);
    }
    throw new Error(`${field} field still wrong after retyping; not submitting`);
}

const jitter = (min, max) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

// ponytail: letters/digits get real code/keyCode; symbols send keyCode 0. Add a
// US-layout table if a bank ever keys on that.
function keyFor(ch) {
    if (/[a-z]/i.test(ch)) {
        const up = ch.toUpperCase();
        return { code: `Key${up}`, windowsVirtualKeyCode: up.charCodeAt(0), modifiers: ch === up ? 8 : 0 };   // 8 = Shift
    }
    if (/\d/.test(ch)) return { code: `Digit${ch}`, windowsVirtualKeyCode: ch.charCodeAt(0) };
    return {};
}

async function pressKey(send, key) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
    await jitter(30, 90);
    const { text, ...up } = key;
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...up });
}

async function typeText(send, str) {
    for (const ch of str) {
        await pressKey(send, { key: ch, text: ch, ...keyFor(ch) });
        await jitter(60, 180);
    }
}
