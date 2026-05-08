onMessage("FETCH_CAPITALONE_TRANSACTIONS", async ({ cardId, startDate, endDate }) => {
    const encodedId = encodeURIComponent(encodeURIComponent(cardId));
    const url = `https://myaccounts.capitalone.com/web-api/protected/19902/credit-cards/accounts/${encodedId}/transactions?fromDate=${startDate}&toDate=${endDate}`;
    const attemptFetch = async (attemptsLeft) => {
        const res = await fetch(url, {
            headers: {
                accept: "application/json;v=1",
                "accept-language": "en-US",
                "x-user-action": "ease.detailsAndTransactionsSummary",
                "x-ui-routing-id": "Card/REFID",
            },
            credentials: "include",
        });
        if (!res.ok) {
            if (attemptsLeft <= 1) throw new Error(`CapitalOne export failed: ${res.status}`);
            await new Promise(r => setTimeout(r, 2000));
            return attemptFetch(attemptsLeft - 1);
        }
        return res.text();
    }
    const data = await attemptFetch(3);
    return { data };
});
