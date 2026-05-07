const SOFI_GQL_QUERY = `query Transactions($accountIDs: [ID!], $pageSize: Int!, $afterCursor: String, $filter: MoneyTransactionFilter) {
  me {
    accounts(filter: {accountIDs: $accountIDs}) {
      ... on CheckingAccount {
        id
        transactions(pageSize: $pageSize, afterCursor: $afterCursor, filter: $filter) { ...txList }
      }
      ... on SavingsAccount {
        id
        transactions(pageSize: $pageSize, afterCursor: $afterCursor, filter: $filter) { ...txList }
      }
      ... on VaultAccount {
        id
        transactions(pageSize: $pageSize, afterCursor: $afterCursor, filter: $filter) { ...txList }
      }
    }
  }
}
fragment txList on PaginatedMoneyTransactionList {
  list {
    cursor
    transaction {
      id
      amount { unformatted }
      createdDate { mmddyyyy }
      description
      displayType
      expandedFields { title value }
      state
    }
  }
}`;

onMessage("GET_CSRF_TOKEN", async () => {
    const csrfToken = await fetchCsrfToken();
    return { csrfToken };
});

onMessage("FETCH_SOFI_TRANSACTIONS", ({ accountId, csrfToken, startDate, endDate }) =>
    fetchTransactions(accountId, csrfToken, startDate, endDate).then(transactions => ({ transactions }))
);

onMessage("FETCH_SOFI_BALANCE", ({ accountId }) => ({
    balance: fetchBalance(accountId),
}));

async function fetchCsrfToken() {
    const cookies = document.cookie.split(";").map(c => c.trim());
    const csrfCookie = cookies.find(c => c.startsWith("SOFI_R_CSRF_TOKEN="));
    if (!csrfCookie) throw new Error("SOFI_R_CSRF_TOKEN not found");
    return csrfCookie.split("=")[1];
}

async function fetchTransactions(accountId, csrfToken, startDate, endDate) {
    const allTransactions = [];
    let afterCursor = null;

    while (true) {
        const response = await fetch("https://www.sofi.com/bff/graphql", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "apollographql-client-name": "banking-accounts-ui",
                "csrf-token": csrfToken,
            },
            credentials: "include",
            body: JSON.stringify({
                operationName: "Transactions",
                variables: {
                    accountIDs: [accountId],
                    pageSize: 500,
                    afterCursor,
                    filter: { days: dateDiffDays(startDate, endDate), dateRange: null, searchText: null, amountFilter: null, transactionTypes: null },
                },
                query: SOFI_GQL_QUERY,
            }),
        });

        if (!response.ok) throw new Error(`SoFi GQL failed: ${response.status}`);

        const json = await response.json();
        const list = json?.data?.me?.accounts?.[0]?.transactions?.list;
        if (!list?.length) break;

        for (const { cursor, transaction: tx } of list) {
            if (tx.state !== "POSTED") continue;
            const date = sofiDateToISO(tx.createdDate.mmddyyyy);
            if (date < startDate || date > endDate) continue;
            const amount = Math.round(parseFloat(tx.amount.unformatted) * 100);
            const merchant = tx.expandedFields?.find(f => f.title === "Merchant")?.value;
            allTransactions.push({
                date,
                amount,
                payee_name: merchant ?? tx.description,
                notes: tx.displayType ?? undefined,
                imported_id: `sofi-${tx.id}`,
            });
        }

        if (list.length < 500) break;
        afterCursor = list[list.length - 1].cursor;
    }

    return allTransactions;
}

function sofiDateToISO(mmddyyyy) {
    const month = mmddyyyy.slice(0, 2);
    const day = mmddyyyy.slice(2, 4);
    const year = mmddyyyy.slice(4, 8);
    return `${year}-${month}-${day}`;
}

function dateDiffDays(startDate, endDate) {
    const [sy, sm, sd] = startDate.split("-").map(Number);
    const [ey, em, ed] = endDate.split("-").map(Number);
    return Math.ceil((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000) + 1;
}

function fetchBalance(accountId) {
    const script = Array.from(document.querySelectorAll("script")).find(s =>
        s.textContent.includes("APOLLO_STATE")
    );
    if (!script) throw new Error("Apollo state script not found");

    const match = script.textContent.match(/window\.APOLLO_STATE\s*=\s*(\{[\s\S]*\})/);
    if (!match) throw new Error("Could not parse Apollo state");

    const apolloState = JSON.parse(match[1]);

    for (const val of Object.values(apolloState)) {
        if (!val || typeof val !== "object") continue;
        if (val.id !== accountId && val.frn !== accountId) continue;

        const raw = val.availableBalance?.unformatted;
        if (raw == null) throw new Error(`availableBalance not found for ${accountId}. Keys: ${Object.keys(val).join(", ")}`);
        return Math.round(parseFloat(raw) * 100);
    }

    throw new Error(`Account ${accountId} not found in Apollo state`);
}
