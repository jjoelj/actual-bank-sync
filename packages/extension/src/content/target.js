chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "FETCH_TARGET_TRANSACTIONS") {
        const { csrfToken, bankId, startDate, endDate } = msg;

        fetch("https://mytargetcirclecard.target.com/services/api/transactions/v1/dtlpostedtransactions", {
            method: "POST",
            headers: {
                accept: "application/json",
                "content-type": "application/json",
                bankid: bankId,
                "x-csrf-token": csrfToken,
            },
            credentials: "include",
            body: JSON.stringify({
                transactionDate: startDate,
                transactionDateEnd: endDate,
                transactionDateRelationalOperator: "BETWEEN",
                pageNumber: 1,
                readCount: 1000,
                flexLinePay: false,
            }),
        })
            .then(r => r.json())
            .then(data => sendResponse({ data }))
            .catch(err => sendResponse({ error: err.message }));

        return true;
    }
});
