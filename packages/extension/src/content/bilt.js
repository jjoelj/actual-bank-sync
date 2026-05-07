onMessage("GET_BILT_DATA", () => {
    const auth = JSON.parse(localStorage.getItem("persist:auth"));
    const accessToken = JSON.parse(auth.accessToken);
    if (!accessToken) throw new Error("No access token found");
    const cardLink = document.querySelector('a[href*="cardId="]');
    if (!cardLink) throw new Error("Card ID link not found");
    const cardId = new URL(cardLink.href, location.origin).searchParams.get("cardId");
    if (!cardId) throw new Error("cardId not in link");
    return { accessToken, cardId };
});

onMessage("FETCH_BILT_BALANCE", async ({ cardId, accessToken }) => {
    const attemptFetch = async (attemptsLeft) => {
        const res = await fetch(`https://api.biltrewards.com/bilt-card/cards/${cardId}/account/summary`, {
            headers: {
                accept: "application/json, text/plain, */*",
                authorization: `Bearer ${accessToken}`,
            },
            credentials: "include",
        });
        if (!res.ok) {
            if (attemptsLeft <= 1) throw new Error(`Bilt balance failed: ${res.status}`);
            await new Promise(r => setTimeout(r, 2000));
            return attemptFetch(attemptsLeft - 1);
        }
        return res.json();
    };
    const json = await attemptFetch(3);
    const amount = json?.currentBalance?.amount;
    if (amount == null) throw new Error("currentBalance.amount not found");
    return { balance: Math.round(amount * 100) };
});

onMessage("FETCH_BILT_TRANSACTIONS", async ({ cardId, startDate, endDate, accessToken }) => {
    const url = `https://api.biltrewards.com/bilt-card/cards/${cardId}/transactions/export?startDate=${startDate}T00:00:00Z&endDate=${endDate}T23:59:59Z`;
    const attemptFetch = async (attemptsLeft) => {
        const res = await fetch(url, {
            headers: {
                accept: "application/json, text/plain, */*",
                authorization: `Bearer ${accessToken}`,
            },
            credentials: "include",
        });
        if (!res.ok) {
            if (attemptsLeft <= 1) throw new Error(`Bilt export failed: ${res.status}`);
            await new Promise(r => setTimeout(r, 2000));
            return attemptFetch(attemptsLeft - 1);
        }
        return res.text();
    };
    const data = await attemptFetch(3);
    return { data };
});
