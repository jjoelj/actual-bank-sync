// Reads texted login codes off Google Messages for web, which must be paired
// in this browser profile. Uses the open Messages tab (only one can be active),
// else launches the installed Messages app (via the native host), else opens a
// pinned tab in the background and leaves it for next time. Not paired (or not
// a Google Messages user) → the tab it opened is closed and the caller falls
// back to the user typing the code.

import { sendToHost } from "./host.js";

const jitter = ms => new Promise(r => setTimeout(r, ms));
const timeout = (p, ms) => Promise.race([p, jitter(ms).then(() => { throw new Error("timed out"); })]);

// Edge's sleeping tabs freeze or discard a background Messages tab, and a
// script injected into a frozen tab hangs. Wake it and keep it awake.
async function messagesTab() {
    // The app's window counts too, so an open app is never launched again.
    const find = async () => (await chrome.tabs.query({ url: "https://messages.google.com/web/*" }))[0];
    let tab = await find();
    // Installed as an app (Edge) → launch it, like its Start menu shortcut.
    if (!tab && await sendToHost("openMessagesApp").catch(() => false)) {
        console.log("Opening the Google Messages app");
        for (const deadline = Date.now() + 15000; !(tab = await find()) && Date.now() < deadline;) await jitter(500);
        // The launcher has no start-minimized option; minimize as soon as it shows.
        if (tab) await chrome.windows.update(tab.windowId, { state: "minimized" }).catch(() => {});
    }
    const opened = !tab;
    if (tab) {
        const { state, type } = await chrome.windows.get(tab.windowId);
        console.log(`Using the open Google Messages tab (${type} window, ${state})`);
    } else {
        console.log("No Google Messages tab open; opening one (pinned)");
        // Not the minimized sync window (the last focused one, so the default):
        // the tab would be hidden there and stall.
        const [win] = (await chrome.windows.getAll({ windowTypes: ["normal"] })).filter(w => w.state !== "minimized");
        tab = await chrome.tabs.create({ url: "https://messages.google.com/web/conversations", active: false, pinned: true, windowId: win?.id });
    }
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
    if (tab.discarded || tab.frozen) await chrome.tabs.reload(tab.id);
    return { tabId: tab.id, opened };
}

// Paired, Messages shows /web/conversations; otherwise it lands somewhere else
// once loaded (/web/welcome, /web/pair, /web/authentication...). A closed tab
// counts too. A brand-new tab reports "complete" on a blank URL; not judged yet.
async function unpaired(tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return true;
    return tab.status === "complete" && !!tab.url?.startsWith("https://messages.google.com/") && !tab.url.includes("/web/conversations");
}

// The 6-digit number in each conversation-list row that mentions `from`, or
// null when the list can't be read (not rendered yet, tab hung). A row reads
// "name preview time"; the last match skips a 6-digit short-code name.
async function codesFrom(tabId, from) {
    const res = await timeout(chrome.scripting.executeScript({
        target: { tabId },
        args: [from.source, from.flags],
        func: (src, flags) => {
            const rows = [...document.querySelectorAll("mws-conversation-list-item")].map(el => el.innerText);
            return rows.length ? rows.filter(t => new RegExp(src, flags).test(t)).map(t => t.match(/\b\d{6}\b/g)?.at(-1)).filter(Boolean) : null;
        },
    }), 5000).catch(() => null);
    return res?.[0]?.result ?? null;
}

// Call before the bank sends the code, then await wait(): resolves with the
// first code that wasn't already on screen, so an old text is never reused.
// Throws if the list can't be read first: without that snapshot an old code
// would look new.
export async function watchForCode(from) {
    const { tabId, opened } = await messagesTab();
    const release = await emulateFocus(tabId);
    let seen;
    for (const deadline = Date.now() + 20000; !(seen = await codesFrom(tabId, from)); await jitter(1000)) {
        const why = await unpaired(tabId) ? "Google Messages for web isn't paired in this browser"
            : Date.now() > deadline ? "couldn't read the Google Messages conversation list" : null;
        if (why) {
            await release();
            if (opened) chrome.tabs.remove(tabId).catch(() => {});
            throw new Error(why);
        }
    }
    seen = new Set(seen);
    return {
        async wait(ms = 90000) {
            for (const deadline = Date.now() + ms; Date.now() < deadline; await jitter(2000)) {
                const code = (await codesFrom(tabId, from))?.find(c => !seen.has(c));
                if (code) return code;
            }
            throw new Error("no new code showed up in Google Messages");
        },
        release,   // call when done, read or not
    };
}

// A background or minimized Messages window can hold off updating its list
// until it's looked at. Focus emulation (debugger attached) keeps it live, as
// with the bank pages; no size override, so a visible app window keeps its
// layout. Edge shows its debugging bar meanwhile. Not attachable (DevTools
// open on it) → carries on without. Resolves the detach.
async function emulateFocus(tabId) {
    const target = { tabId };
    try {
        await chrome.debugger.attach(target, "1.3");
        await chrome.debugger.sendCommand(target, "Emulation.setFocusEmulationEnabled", { enabled: true });
    } catch {
        return async () => {};
    }
    return () => chrome.debugger.detach(target).catch(() => {});
}
