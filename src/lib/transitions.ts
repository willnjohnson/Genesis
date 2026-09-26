// Transitions when entering, leaving or switching workspaces. Every switch reloads the window (see
// components/workspace/helpers.ts), so the effect has to span the reload:
//   1. the page zooms away while a screen with a 3x3 Game of Life block fades in over it;
//   2. the reload happens behind that screen (public/k-life.js puts it back up the moment the page
//      starts loading, told so through sessionStorage);
//   3. once the new workspace is ready the screen fades out and the workspace zooms in.
// The zoom animations are in index.css. They're put on <body> so the overlays portaled into it (the
// Workspaces screen) move along with the app.

const KEY = "k-transition";
const LABEL_KEY = "k-transition-label";
export const LEAVE_MS = 220;

interface KLife {
    show(fade?: boolean, remember?: boolean, label?: string): void;
    hide(): void;
}
declare global {
    interface Window { kLife?: KLife }
}

export const prefersReducedMotion = () =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Zooms the page away over the Life screen, then reloads it; the new page reveals itself with
 *  `revealAfterSwitch`. */
export function reloadWithTransition(workspaceName?: string) {
    if (prefersReducedMotion()) {
        window.location.reload();
        return;
    }
    // The Life screen says which workspace is loading; the reloaded page's copy of it reads the name from here.
    const label = workspaceName ? `Loading ${workspaceName}` : "Loading workspace";
    try {
        sessionStorage.setItem(KEY, "enter");
        sessionStorage.setItem(LABEL_KEY, label);
    } catch { /* storage blocked: reload without the effect */ }
    window.kLife?.show(true, true, label);
    document.documentElement.classList.add("k-switching");
    document.body.classList.add("k-leave-forward");
    window.setTimeout(() => window.location.reload(), LEAVE_MS);
}

/** After such a reload, once the app can be shown: takes the Life screen down and zooms the new page
 *  in. Does nothing on an ordinary start. */
export function revealAfterSwitch() {
    let pending = false;
    try {
        pending = sessionStorage.getItem(KEY) === "enter";
        sessionStorage.removeItem(KEY);
    } catch { /* nothing to reveal */ }
    if (!pending) return;
    window.kLife?.hide();
    if (prefersReducedMotion()) return;
    const body = document.body;
    body.classList.add("k-enter-forward");
    body.addEventListener("animationend", () => body.classList.remove("k-enter-forward"), { once: true });
}
