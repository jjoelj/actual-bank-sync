// Runs in the page (MAIN world) at document_start. Sync windows open minimized,
// and some bank pages stall or skip work while hidden, so report the page as
// visible and focused, and swallow the page-level visibility/blur events.
// Edge also pauses requestAnimationFrame entirely in a minimized window, and
// site code that waits on a frame hangs (Fidelity's rewards hand-off did), so
// each frame request also gets a timer fallback; whichever fires first runs it.
// ponytail: timers are still throttled (~1/s) while hidden, so animation-heavy
// flows run slowly, not stall. If a bank still hangs, give it a normal window.
Object.defineProperty(Document.prototype, "visibilityState", { get: () => "visible", configurable: true });
Object.defineProperty(Document.prototype, "hidden", { get: () => false, configurable: true });
Document.prototype.hasFocus = () => true;
for (const type of ["visibilitychange", "webkitvisibilitychange", "blur", "pagehide", "freeze"]) {
    // Only page-level events: element blurs (form validation) pass through.
    window.addEventListener(type, e => {
        if (e.target === window || e.target === document) e.stopImmediatePropagation();
    }, true);
}

const realRaf = window.requestAnimationFrame.bind(window);
const realCancelRaf = window.cancelAnimationFrame.bind(window);
const frames = new Map();
let nextFrameId = 1;
window.requestAnimationFrame = (callback) => {
    const id = nextFrameId++;
    const run = (time) => {
        const f = frames.get(id);
        if (!f) return;   // already ran, or cancelled
        frames.delete(id);
        realCancelRaf(f.raf);
        clearTimeout(f.timer);
        callback(time);
    };
    frames.set(id, { raf: realRaf(run), timer: setTimeout(() => run(performance.now()), 50) });
    return id;
};
window.cancelAnimationFrame = (id) => {
    const f = frames.get(id);
    if (!f) return;
    frames.delete(id);
    realCancelRaf(f.raf);
    clearTimeout(f.timer);
};
