onMessage("FETCH_TARGET_BALANCE", ({ csrfToken, bankId }) =>
    fetch("https://mytargetcirclecard.target.com/services/api/accounts/v1/accountsummary", {
        headers: {
            accept: "application/json",
            bankid: bankId,
            "x-csrf-token": csrfToken,
        },
        credentials: "include",
    })
        .then(r => r.json())
        .then(data => {
            const amount = data?.accounts?.[0]?.currentBalanceAmount;
            if (amount == null) throw new Error("currentBalanceAmount not found");
            return { balance: Math.round(amount * 100) };
        })
);

onMessage("FETCH_TARGET_TRANSACTIONS", ({ csrfToken, bankId, startDate, endDate }) =>
    fetch("https://mytargetcirclecard.target.com/services/api/transactions/v1/dtlpostedtransactions", {
        method: "POST",
        headers: {
            accept: "application/json",
            "content-type": "application/json",
            bankid: bankId,
            "x-csrf-token": csrfToken,
        },
        credentials: "include",
        body: JSON.stringify({
            transactionDate: startDate,
            transactionDateEnd: endDate,
            transactionDateRelationalOperator: "BETWEEN",
            pageNumber: 1,
            readCount: 1000,
            flexLinePay: false,
        }),
    })
        .then(r => r.json())
        .then(data => ({ data }))
);
