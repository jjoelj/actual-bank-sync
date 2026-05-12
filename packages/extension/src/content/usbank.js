onMessage("GET_USBANK_DATA", () => {
    const accessToken = sessionStorage.getItem("AccessToken");
    if (!accessToken) return null;
    const afToken = sessionStorage.getItem("AFTokenValue") || null;
    let accounts = [];
    try {
        const raw = sessionStorage.getItem("CADEligibileAccounts");
        if (raw) accounts = JSON.parse(raw);
    } catch {}
    return { accessToken, afToken, accounts };
});

onMessage("FETCH_USBANK_ACCOUNTS", ({ accessToken, accountTokens }) =>
    fetch("https://onlinebanking.usbank.com/digital/api/customer-management/graphql/v2", {
        method: "POST",
        headers: {
            accept: "*/*",
            "application-id": "ADCR_DT",
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            routingkey: "",
            "service-version": "2",
        },
        credentials: "include",
        body: JSON.stringify({
            query: `query accounts($accountInput: AccountInput) {
  accounts(accountInput: $accountInput) {
    accountType
    accountNumber
    uniqueIdentifier
    ... on CreditAccount {
      balances { currentBalance }
      details { cardName }
    }
  }
}`,
            variables: {
                accountInput: {
                    accountTokens: Array.isArray(accountTokens) ? accountTokens : [accountTokens],
                    identifierType: "ACCOUNTTOKEN",
                },
            },
        }),
    })
        .then(r => r.json())
        .then(json => ({ accounts: json?.data?.accounts ?? [] }))
);

const TRANSACTIONS_QUERY = `query txnsDetails($input: TxnsAcctSearchRequestInput) {
  txnsDetails(txnsAcctSearchRequestInput: $input) {
    txnsResponse {
      postedTransactions {
        transactionUniqueId
        transactionAmount
        postedDateTime
        description
        debitCreditMemo
        enrichedDetails {
          category
        }
      }
      _metadata {
        pageNumber
        totalPages
      }
    }
  }
}`;

onMessage("FETCH_USBANK_TRANSACTIONS", ({ accessToken, afToken, accountToken, startDate, endDate, pageNumber }) =>
    fetch("https://onlinebanking.usbank.com/digital/api/customer-management/graphql/v2", {
        method: "POST",
        headers: {
            accept: "*/*",
            "application-id": "UAL_ADCR",
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            ...(afToken ? { aftokenvalue: afToken } : {}),
            routingkey: "",
        },
        credentials: "include",
        body: JSON.stringify({
            query: TRANSACTIONS_QUERY,
            variables: {
                input: {
                    accountTokens: [accountToken],
                    startTime: startDate,
                    endTime: endDate,
                    limit: "500",
                    pageName: "UNIVERSAL_ACTIVITY_UBER",
                    pageNumber: String(pageNumber),
                    offset: "1",
                },
            },
        }),
    })
        .then(r => r.json())
        .then(json => ({
            transactions: json?.data?.txnsDetails?.txnsResponse?.postedTransactions ?? [],
            totalPages: json?.data?.txnsDetails?.txnsResponse?._metadata?.totalPages ?? 1,
        }))
);
