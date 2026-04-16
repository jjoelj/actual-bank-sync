chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "GET_BILT_DATA") {
        try {
            const auth = JSON.parse(localStorage.getItem("persist:auth"));
            const accessToken = JSON.parse(auth.accessToken);
            if (!accessToken) throw new Error("No access token found");

            const cardLink = document.querySelector('a[href*="cardId="]');
            if (!cardLink) throw new Error("Card ID link not found");
            const cardId = new URL(cardLink.href, location.origin).searchParams.get("cardId");
            if (!cardId) throw new Error("cardId not in link");

            sendResponse({ accessToken, cardId });
        } catch (err) {
            sendResponse({ error: err.message });
        }
        return true;
    }

    if (msg.type === "FETCH_BILT_TRANSACTIONS") {
        const { cardId, startDate, endDate, accessToken } = msg;
        const url = `https://api.biltrewards.com/bilt-card/cards/${cardId}/transactions/export?startDate=${startDate}T00:00:00Z&endDate=${endDate}T23:59:59Z`;

        const attemptFetch = async (attemptsLeft) => {
            try {
                const res = await fetch(url, {
                    headers: {
                        accept: "application/json, text/plain, */*",
                        authorization: `Bearer ${accessToken}`,
                    },
                    credentials: "include",
                });
                if (!res.ok) throw new Error(`Bilt export failed: ${res.status}`);
                return await res.text();
            } catch (err) {
                if (attemptsLeft <= 1) throw err;
                await new Promise(r => setTimeout(r, 2000));
                return attemptFetch(attemptsLeft - 1);
            }
        };

        attemptFetch(3)
            .then(data => sendResponse({ data }))
            .catch(err => sendResponse({ error: err.message }));

        return true;
    }
});
