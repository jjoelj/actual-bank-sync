onMessage("GET_FIDELITY_DATA", () => {
    const accessToken = sessionStorage.getItem("AccessToken");
    if (!accessToken) throw new Error("AccessToken not found");
    const meta = JSON.parse(sessionStorage.getItem("multiAccountMetaData"));
    const accountToken = meta?.accounts?.[0]?.accountToken;
    if (!accountToken) throw new Error("accountToken not found");
    return { accessToken, accountToken };
});

const CREDIT_TX_QUERY = `query creditTransactionDetails($input: CreditTransactionsSearchRequestInput) {
  creditTransactionDetails(transactionsSearchRequestInput: $input) {
    creditCardTransactions {
      transactionUniqueId
      transactionDateTime
      effectiveDate
      postedDateTime
      transactionAmount
      debitCredit
      description
      transactionType
      transactionTypeDesc
      pendingFlag
      transactionStatus
      merchantDetails { name }
      enrichedDetails { category }
    }
    _metadata { pageNumber totalPages totalRecords }
  }
}`;

onMessage("FETCH_FIDELITY_TRANSACTIONS", async ({ accessToken, accountToken, startDate, endDate }) => {
    const limit = 500;
    const maxPages = 200;
    const all = [];
    const seen = new Set();

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
        const res = await fetch("https://login.fidelityrewards.com/digital/api/partner-services/graphql/v1", {
            method: "POST",
            credentials: "include",
            headers: {
                accept: "*/*",
                "application-id": "RPCADTRAN",
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
                query: CREDIT_TX_QUERY,
                variables: {
                    input: {
                        accountToken,
                        limit: String(limit),
                        offset: String((pageNumber - 1) * limit + 1),
                        pageNumber: String(pageNumber),
                        startTime: startDate,
                        endTime: endDate,
                        extendPayEnable: false,
                    },
                },
            }),
        });
        if (!res.ok) throw new Error(`Fidelity transactions failed: ${res.status}`);
        const json = await res.json();
        if (json.errors?.length) throw new Error(json.errors[0]?.message || "Fidelity GraphQL error");

        const detail = json?.data?.creditTransactionDetails;
        const txns = detail?.creditCardTransactions || [];

        let added = 0;
        for (const tx of txns) {
            const key = tx.transactionUniqueId || `${tx.transactionDateTime}|${tx.transactionAmount}|${tx.description}`;
            if (seen.has(key)) continue;
            seen.add(key);
            all.push(tx);
            added++;
        }

        const totalPages = Number(detail?._metadata?.totalPages) || 1;
        if (txns.length < limit || pageNumber >= totalPages || added === 0) break;
    }

    return { transactions: all };
});
