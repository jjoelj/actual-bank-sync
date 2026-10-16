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

// Barclays' password field is type="text" with a CSS mask, so match it by
// id/name/data-auto, not type. The login lives in an iframe (all_frames injects
// us there too); only the frame that has the field acts.
const PW_SEL = '#password, input[name="uxLoginForm.password"], input[data-auto="pass-word"]';

registerLogin("samsung", PW_SEL);

// The CSS-masked text field also blocks Edge's password autofill; turn it back
// into a real password input so manual logins can autofill.
function enablePasswordAutofill() {
    const el = document.querySelector(PW_SEL);
    if (!el || el.type === "password") return;
    el.type = "password";
    el.classList.remove("text-security-marker", "text-security-disc");
    el.setAttribute("autocomplete", "current-password");
}
new MutationObserver(enablePasswordAutofill).observe(document.documentElement, { childList: true, subtree: true });
enablePasswordAutofill();
