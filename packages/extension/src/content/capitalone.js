onMessage("GET_CAPITALONE_DATA", () => {
    const tile = document.querySelector('[id^="account-"]');
    if (!tile) throw new Error("Account tile not found");
    const accountId = tile.id.replace("account-", "");
    if (!accountId) throw new Error("Account ID not found");
    return { accountId };
});
