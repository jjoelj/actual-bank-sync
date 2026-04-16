chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "GET_CAPITALONE_DATA") {
        try {
            const tile = document.querySelector('[id^="account-"]');
            if (!tile) throw new Error("Account tile not found");
            const accountId = tile.id.replace("account-", "");
            if (!accountId) throw new Error("Account ID not found");
            sendResponse({ accountId });
        } catch (err) {
            sendResponse({ error: err.message });
        }
        return true;
    }
});
