// Samsung Galaxy Card is serviced by Barclays (barclaycardus.com).
const BASE = "https://www.barclaycardus.com/servicing/jserv";

onMessage("FETCH_SAMSUNG_TRANSACTIONS", ({ accountId }) =>
    // ponytail: cycleDate=9999-12-31 returns only the current (unbilled) cycle.
    // Fine for incremental syncs; add cycleDate pagination if backfill or
    // cycle-boundary gaps matter.
    fetch(`${BASE}/xapi/transactionsummary/v1/cards/accounts/${accountId}/transactions?journeyIndicator=TRANSACTION_SUMMARY&transactionStatus=POSTED&enrichedTransactions=true&cycleDate=9999-12-31`, {
        headers: { accept: "application/json, text/plain, */*", adrum: "isAjax:true", "correlation-id": crypto.randomUUID() },
        credentials: "include",
    })
        .then(r => { if (!r.ok) throw new Error(`transactions ${r.status}`); return r.json(); })
        .then(json => ({ data: json?.data || [] }))
);

onMessage("FETCH_SAMSUNG_BALANCE", () =>
    fetch(`${BASE}/accountTile/?_=${Date.now()}`, {
        headers: { accept: "*/*", "bcus-ajax": "true", "x-requested-with": "XMLHttpRequest" },
        credentials: "include",
    })
        .then(r => { if (!r.ok) throw new Error(`balance ${r.status}`); return r.json(); })
        .then(d => ({ balance: d?.balance }))
);

// Barclays' password field is type="text" with a CSS masking trick specifically
// so it won't autofill. Match it by id/name/data-auto (not type) and turn it back
// into a real password input, so the password manager fills Barclays' own field
// directly. The login lives in an iframe (all_frames injects us there too), so an
// injected overlay would get clipped — converting the field avoids UI entirely.
const PW_SEL = '#password, input[name="uxLoginForm.password"], input[data-auto="pass-word"]';

let converted = false;
function enablePasswordAutofill() {
    if (converted) return;
    const el = document.querySelector(PW_SEL);
    if (!el) return;
    el.type = "password";
    el.classList.remove("text-security-marker", "text-security-disc");
    el.setAttribute("autocomplete", "current-password");
    converted = true;
    console.log("[bank-sync] enabled autofill on Barclays password field");
}

// Triggered during an extension-driven sync; also runs on its own below so a
// manual login gets the fix too. We never submit — the user logs in themselves.
onMessage("SAMSUNG_LOGIN", () => { enablePasswordAutofill(); return { done: true }; });

// The field is rendered late by the Angular login app, so watch for it.
console.log("[bank-sync] samsung content script loaded:", location.href, "(top frame:", window.top === window, ")");
const loginObserver = new MutationObserver(enablePasswordAutofill);
loginObserver.observe(document.documentElement, { childList: true, subtree: true });
enablePasswordAutofill();
