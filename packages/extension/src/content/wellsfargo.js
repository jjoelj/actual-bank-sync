onMessage("FETCH_WF_TRANSACTIONS", ({ accountId, xatoken, startDate, endDate }) => {
    const query = `\n{\n  downloadAccountData(downloadAccountDataRequest: {\n    accountId: "${accountId}",\n    types: [\n      {\n        fromDate: "${startDate}",\n        toDate: "${endDate}",\n        fileFormat: "commaDelimited",\n        type: ACTIVITY,\n\t      includePendingTransactions: false\n      }\n    ]\n  }) {\n    status\n    fileName\n    activities\n  }\n}`;

    return fetch("https://connect.secure.wellsfargo.com/xapi/retailbanking/services/v1/graphql", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-wf-dig-xatoken": xatoken,
            "x-wf-request-date": new Date().toISOString().replace("Z", "-00:00"),
            "x-correlation-id": crypto.randomUUID(),
            "x-request-id": crypto.randomUUID(),
        },
        credentials: "include",
        body: JSON.stringify({ query }),
    })
        .then(r => r.json())
        .then(json => {
            const activities = json?.data?.downloadAccountData?.activities ?? "";
            return { data: activities };
        });
});
