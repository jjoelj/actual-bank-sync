// content/sofi.js - injected into https://www.sofi.com/my/banking/*
// Handles messages from background asking for the CSRF token

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_CSRF_TOKEN") {
    fetchCsrfToken()
      .then((csrfToken) => sendResponse({ csrfToken }))
      .catch((err) => sendResponse({ error: err.message }));
    return true; // async
  }
});

async function fetchCsrfToken() {
  // Read the cookie value
  const cookies = document.cookie.split(";").map((c) => c.trim());
  const csrfCookie = cookies.find((c) => c.startsWith("SOFI_R_CSRF_TOKEN="));
  if (!csrfCookie) {
    throw new Error("SOFI_R_CSRF_TOKEN not found");
  }
  return csrfCookie.split("=")[1];
}
