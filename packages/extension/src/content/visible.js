// Runs in the page (MAIN world) at document_start. Sync windows open minimized,
// and some bank pages stall or skip work while hidden, so report the page as
// visible and focused, and swallow the page-level visibility/blur events.
// ponytail: this fakes only what JS can see; Edge still throttles timers and
// pauses requestAnimationFrame in a minimized window. If a bank stalls anyway,
// give that bank a normal window.
Object.defineProperty(Document.prototype, "visibilityState", { get: () => "visible", configurable: true });
Object.defineProperty(Document.prototype, "hidden", { get: () => false, configurable: true });
Document.prototype.hasFocus = () => true;
for (const type of ["visibilitychange", "webkitvisibilitychange", "blur", "pagehide", "freeze"]) {
    // Only page-level events: element blurs (form validation) pass through.
    window.addEventListener(type, e => {
        if (e.target === window || e.target === document) e.stopImmediatePropagation();
    }, true);
}
