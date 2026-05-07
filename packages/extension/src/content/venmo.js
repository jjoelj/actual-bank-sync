onMessage("GET_VENMO_PROFILE_ID", () => {
    const link = document.querySelector('a[href*="profileId"]');
    if (!link) throw new Error("Profile ID link not found");
    const url = new URL(link.href);
    const profileId = url.searchParams.get("profileId");
    if (!profileId) throw new Error("profileId not in link");
    return { profileId };
});
