function parseWFBody(text) {
    let body = text.trim();
    if (body.startsWith('"')) body = JSON.parse(body);
    body = body.replace(/^.*?WellFargoProprietary%/s, "").replace(/%WellFargoProprietary.*$/s, "");
    return JSON.parse(body);
}

onMessage("FETCH_WF_TRANSACTIONS", async ({ reqUrl }) => {
    const res = await fetch(reqUrl, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/plain, */*",
        },
        credentials: "include",
        body: JSON.stringify({
            requestedPageNumber: 1,
            searchCriterias: [{ filterType: "ALL" }],
            sortCriteriaData: { sortOrder: "DESCENDING", sortingList: "ALL", sortColumn: "POSTING_DATE" },
            transactionType: "MEMO_POSTED",
            hasFormSearched: false,
            showTempAuth: true,
            collapseTempAuth: false,
            type: "credit",
        }),
    });
    if (!res.ok) throw new Error(`WF transactions failed: ${res.status}`);
    return { data: parseWFBody(await res.text()) };
});

onMessage("FETCH_WF_CATEGORIES", async ({ additionalDetailsUrl, transactionIds }) => {
    const origin = "https://connect.secure.wellsfargo.com";
    const base = additionalDetailsUrl.startsWith("http") ? additionalDetailsUrl : origin + additionalDetailsUrl;
    const categories = {};

    for (const id of transactionIds) {
        try {
            const res = await fetch(`${base}&transactionId=${encodeURIComponent(id)}`, {
                headers: { accept: "application/json, text/plain, */*" },
                credentials: "include",
            });
            if (!res.ok) continue;
            const json = parseWFBody(await res.text());
            const category = json?.accountModel?.additionalTransactionDetailsData?.category;
            if (category) categories[id] = category;
        } catch {
            // Skip transactions whose detail call fails; they import without a category.
        }
        await new Promise(r => setTimeout(r, 150));
    }

    return { categories };
});
