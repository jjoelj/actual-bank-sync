chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "FETCH_WF_TRANSACTIONS") {
        const { accountId, downloadUrl, startDate, endDate } = msg;

        const formData = new FormData();
        formData.append("accountId", accountId);
        formData.append("fromDate", startDate);
        formData.append("toDate", endDate);
        formData.append("fileFormat", "commaDelimited");

        fetch(downloadUrl, {
            method: "POST",
            body: formData,
            credentials: "include",
        })
            .then(r => r.text())
            .then(data => sendResponse({ data }))
            .catch(err => sendResponse({ error: err.message }));

        return true;
    }
});
