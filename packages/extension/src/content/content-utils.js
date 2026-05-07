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
