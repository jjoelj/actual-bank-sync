import { loadLogin } from "./host.js";
import { watchForCode } from "./sms.js";

// Logs in with the saved login using trusted input: keystrokes go through the
// DevTools protocol, so the page sees isTrusted keydown/keyup events with
// human-ish timing, and Enter submits (no synthetic click). The bank's content
// script must call registerLogin() so FOCUS_LOGIN_FIELD can focus each field.
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
    if (typeof login.password !== "string") {
        // Malformed save (seen on sofi): treat as unsaved so the manual login re-saves it.
        console.warn(`${bank}: saved login has no password (keys: ${Object.keys(login)}); log in by hand to re-save it`);
        return false;
    }

    try {
        return await withDebugger(tabId, async send => {
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
                await pressKey(send, SPACE);
            } else {
                // Re-focus so Enter can't land elsewhere (select-all doesn't change the value).
                if (!(await ask(tabId, { type: "FOCUS_LOGIN_FIELD", field: "password" })).ok) throw new Error("lost the password field before submitting");
                await pressKey(send, ENTER);
            }
            console.log(`${bank}: submitted saved login`);
            await waitForNavigation(tabId);
            return true;
        });
    } catch (err) {
        console.warn(`${bank}: auto-login failed:`, err.message);
        return false;
    }
}

export const SPACE = { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " };
export const ENTER = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" };

// Runs fn(send) with the debugger attached and the background tab acting
// focused at desktop size. Throws if it can't attach (DevTools open on the tab?).
// Edge shows a "debugging this browser" bar while attached.
export async function withDebugger(tabId, fn) {
    const target = { tabId };
    await chrome.debugger.attach(target, "1.3");
    const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
    try {
        // The sync tab is in the background; make it behave as focused so it accepts input.
        await send("Emulation.setFocusEmulationEnabled", { enabled: true });
        // A window created minimized has no real size, so responsive pages lay
        // out narrow and can hide the sign-in box (Wells Fargo's homepage).
        // Lay out at desktop size while signing in; cleared on detach.
        await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 0, mobile: false });
        return await fn(send);
    } finally {
        await chrome.debugger.detach(target).catch(() => {});
    }
}

// Stay attached until the page navigates (≤10s): detaching ends focus
// emulation, and a submit handler that does async work first (Target)
// stalls once the minimized page goes back to unfocused.
export async function waitForNavigation(tabId) {
    const { url: before } = await chrome.tabs.get(tabId);
    for (const deadline = Date.now() + 10000; Date.now() < deadline; await jitter(250, 250)) {
        const t = await chrome.tabs.get(tabId);
        if (t.status === "loading" || t.url !== before) break;
    }
}

// Presses the button that texts the code (the first sendButton whose text
// matches sendButtonText, if given), reads the code off Google Messages
// (a conversation mentioning `from`), types it into codeBox and presses Enter,
// all with trusted input. Resolves false on any failure; the caller then
// shows the window so the user can finish. say(msg, frac) reports each step.
export async function enterTextedCode(tabId, bank, { from, sendButton, sendButtonText, codeBox }, say = () => {}) {
    let sms;
    try {
        console.log(`${bank}: reading Google Messages before asking for the code`);
        say("Checking Google Messages…", 0.3);
        // Before the text is sent. A failed read still asks for the text, so
        // the user only has to type the code.
        sms = await watchForCode(from).catch(err => err);
        console.log(`${bank}: asking for the code by text`);
        say("Asking for a texted code…", 0.4);
        await withDebugger(tabId, async send => {
            await focusWhenReady(tabId, sendButton, sendButtonText);
            await jitter(150, 300);
            // From the page: WF's button ignores trusted Space and mouse clicks.
            await chrome.scripting.executeScript({ target: { tabId }, func: () => document.activeElement.click() });
        });
        if (sms instanceof Error) throw sms;
        say("Waiting for the texted code…", 0.5);
        const code = await sms.wait();
        await sms.release();
        console.log(`${bank}: got the texted code; entering it`);
        say("Entering the texted code…", 0.7);
        await withDebugger(tabId, async send => {
            await focusWhenReady(tabId, codeBox);
            await jitter(200, 500);
            await typeText(send, code);
            const [typed] = await chrome.scripting.executeScript({ target: { tabId }, args: [codeBox], func: sel => document.querySelector(sel)?.value });
            if (typed?.result !== code) throw new Error("code box didn't take every keystroke");
            await pressKey(send, ENTER);
            await waitForNavigation(tabId);
        });
        return true;
    } catch (err) {
        console.warn(`${bank}: couldn't enter the texted code:`, err.message);
        return false;
    } finally {
        await sms?.release?.();   // Messages tab's debugger, if still attached
    }
}

// Focuses the first `sel` (whose text matches `text`, if given) in the top
// frame. It can show up a beat after the screen does, so keeps trying for 15s;
// the error says what it saw instead.
async function focusWhenReady(tabId, sel, text) {
    let seen;
    for (const deadline = Date.now() + 15000; (seen = await focusOnce(tabId, sel, text)) !== "ok"; await jitter(500, 500)) {
        if (Date.now() > deadline) throw new Error(`couldn't focus ${sel}: ${seen}`);
    }
}

const focusOnce = (tabId, sel, text) => chrome.scripting.executeScript({
    target: { tabId },
    args: [sel, text?.source ?? null, text?.flags ?? ""],
    func: (sel, src, flags) => {
        const all = [...document.querySelectorAll(sel)];
        const el = src ? all.find(e => new RegExp(src, flags).test(e.textContent)) : all[0];
        if (!el) return `not found; matches: ${JSON.stringify(all.map(e => e.textContent))}`;
        el.focus();
        if (document.activeElement === el) return "ok";
        return `found but focus went to ${document.activeElement?.tagName}.${document.activeElement?.className}; disabled=${el.disabled}`;
    },
}).then(([r]) => r?.result).catch(err => err.message);

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

export const jitter = (min, max) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

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

export async function pressKey(send, key) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
    await jitter(30, 90);
    const { text, ...up } = key;
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...up });
}

export async function typeText(send, str) {
    for (const ch of str) {
        await pressKey(send, { key: ch, text: ch, ...keyFor(ch) });
        await jitter(60, 180);
    }
}
