chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "GET_FIDELITY_DATA") {
        try {
            const accessToken = sessionStorage.getItem("AccessToken");
            if (!accessToken) throw new Error("AccessToken not found");

            const meta = JSON.parse(sessionStorage.getItem("multiAccountMetaData"));
            const accountToken = meta?.accounts?.[0]?.accountToken;
            if (!accountToken) throw new Error("accountToken not found");

            sendResponse({ accessToken, accountToken });
        } catch (err) {
            sendResponse({ error: err.message });
        }
        return true;
    }

    if (msg.type === "FETCH_FIDELITY_TRANSACTIONS") {
        const { accessToken, accountToken, startDate, endDate } = msg;

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
            .then(data => sendResponse({ data }))
            .catch(err => sendResponse({ error: err.message }));

        return true;
    }

    if (msg.type === "GET_FIDELITY_SSO_LINK") {
        const { last4 } = msg;

        fetch("https://digital.fidelity.com/ftgw/digital/credit-card/api/graphql", {
            method: "POST",
            headers: {
                accept: "*/*",
                "content-type": "application/json",
                "apollographql-client-name": "credit-card",
                "apollographql-client-version": "0.0.1",
            },
            credentials: "include",
            body: JSON.stringify({
                operationName: "ssoLink",
                variables: {
                    channelCode: "WEB",
                    selectedDestination: "downloadTrans",
                    fvCreditCardNum: last4,
                },
                query: `query ssoLink($channelCode: String, $selectedDestination: String, $fvCreditCardNum: String, $destinationdatacontext: DestinationDataContext) {
                          ssoLink(channelCode: $channelCode selectedDestination: $selectedDestination fvCreditCardNum: $fvCreditCardNum destinationdatacontext: $destinationdatacontext) {
                            links { link { uri title rel __typename } __typename }
                            ssoToken entityId destination __typename
                          }
                        }`,
            }),
        })
            .then(r => r.json())
            .then(data => {
                const uri = data?.data?.ssoLink?.links?.[0]?.link?.uri;
                const url = uri?.startsWith("http") ? uri : `https://digital.fidelity.com${uri}`;
                sendResponse({ url });
            })
            .catch(err => sendResponse({ error: err.message }));

        return true;
    }
});
