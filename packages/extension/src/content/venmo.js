chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "GET_VENMO_PROFILE_ID") {
        try {
            const link = document.querySelector('a[href*="profileId"]');
            if (!link) throw new Error("Profile ID link not found");
            const url = new URL(link.href);
            const profileId = url.searchParams.get("profileId");
            if (!profileId) throw new Error("profileId not in link");
            sendResponse({ profileId });
        } catch (err) {
            sendResponse({ error: err.message });
        }
        return true;
    }
});
