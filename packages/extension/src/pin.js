import { hasPin, resetPin, unlockWithPin } from "./host.js";

// Opened by the background when saved logins need the PIN; it watches for the
// session key to appear. Closing the window means the user skipped it.
// Choosing a PIN takes two passes through the same field: enter, then confirm.

const $ = (id) => document.getElementById(id);
const pin = $("pin");
const cells = [...document.querySelectorAll(".cell")];
let choosing = false;
let first = null;   // the PIN typed on the choose pass, awaiting confirmation
let busy = false;

function paint() {
  const n = pin.value.length;
  cells.forEach((c, i) => {
    c.classList.toggle("filled", i < n);
    c.classList.toggle("active", i === Math.min(n, 5));
  });
}

function say(text, isError = false) {
  $("message").textContent = text;
  $("message").className = isError ? "error" : "";
  $("cells").classList.toggle("error", isError);
  if (isError) {
    $("cells").classList.remove("shake");
    void $("cells").offsetWidth;   // restart the animation
    $("cells").classList.add("shake");
  }
}

function clear() {
  pin.value = "";
  paint();
  pin.focus();
}

async function render() {
  choosing = !(await hasPin());
  first = null;
  $("title").textContent = choosing ? "Protect saved logins" : "Unlock saved logins";
  $("prompt").textContent = choosing ? "Choose a 6-digit PIN" : "Enter your 6-digit PIN";
  $("forgot").hidden = choosing;
  clear();
}

async function submit(value) {
  if (choosing && first === null) {
    first = value;
    $("prompt").textContent = "Enter it again to confirm";
    say("");
    return clear();
  }
  if (choosing && value !== first) {
    first = null;
    $("prompt").textContent = "Choose a 6-digit PIN";
    say("PINs didn't match. Try again.", true);
    return clear();
  }
  busy = true;
  $("cells").classList.add("busy");
  say(choosing ? "Saving…" : "Unlocking…");
  const ok = await unlockWithPin(value).catch(() => false);
  busy = false;
  $("cells").classList.remove("busy");
  if (ok) return window.close();
  say("Wrong PIN.", true);
  clear();
}

pin.addEventListener("input", () => {
  if (busy) return;
  pin.value = pin.value.replace(/\D/g, "").slice(0, 6);
  if (pin.value) $("cells").classList.remove("error");
  paint();
  if (pin.value.length === 6) submit(pin.value);
});
pin.addEventListener("focus", () => $("cells").classList.add("focused"));
pin.addEventListener("blur", () => $("cells").classList.remove("focused"));
document.addEventListener("click", () => pin.focus());

$("forgot").addEventListener("click", async (e) => {
  e.stopPropagation();
  if (!confirm("Clear all saved bank logins? You'll log in by hand once per bank to save them again.")) return;
  await resetPin();
  say("");
  await render();
});

render();
