onMessage("GET_FIDELITY_DATA", () => {
    const accessToken = sessionStorage.getItem("AccessToken");
    if (!accessToken) throw new Error("AccessToken not found");
    const meta = JSON.parse(sessionStorage.getItem("multiAccountMetaData"));
    const accountToken = meta?.accounts?.[0]?.accountToken;
    if (!accountToken) throw new Error("accountToken not found");
    return { accessToken, accountToken };
});

onMessage("FETCH_FIDELITY_TRANSACTIONS", ({ accessToken, accountToken, startDate, endDate }) =>
    fetch("https://api.usbank.com/partner-services/graphql/v1/downloads", {
        method: "POST",
        headers: {
            accept: "*/*",
            "accept-language": "en-US,en;q=0.9",
            "application-id": "RPCTRANDOWNLOADCRDTXN",
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            "correlation-id": crypto.randomUUID(),
            customergroupid: "ELAN",
            customerpartnerid: "fid",
            customerpartnerloc: "24193",
            routingkey: "",
            "service-version": "2",
        },
        body: JSON.stringify({
            requestType: {
                serviceType: "ACCOUNT_TRANSACTION",
                serviceSubType: "HISTORY_DOWNLOAD",
            },
            data: {
                accountToken,
                searchBy: [],
                startTime: startDate,
                endTime: endDate,
                fileType: "CSV",
            },
        }),
    })
        .then(r => r.text())
        .then(data => ({ data }))
);
