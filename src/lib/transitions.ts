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
const BAR_KEY = "k-transition-bar";

// What a snapshot of the title bar carries over: enough to look the same with no stylesheet (the reload has taken
// the page's own away, and in development it isn't there until the app's scripts run).
const SNAPSHOT_PROPS = [
    "display", "position", "box-sizing", "flex-direction", "flex-grow", "flex-shrink", "align-items", "justify-content", "gap",
    "grid-template-columns", "width", "height", "min-width", "top", "left", "opacity", "visibility", "overflow",
    "padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top", "margin-right", "margin-bottom", "margin-left",
    "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
    "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
    "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "border-top-left-radius",
    "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius",
    "background-color", "color", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "white-space",
    "cursor", "user-select", "pointer-events", "stroke", "stroke-width", "fill", "transform",
    "-webkit-mask-image", "-webkit-mask-size", "-webkit-mask-repeat", "-webkit-mask-position", "mask-image", "mask-size", "mask-repeat", "mask-position",
];

/** The title bar as it looks right now, as markup with its styles written in, so the switching screen (public/k-life.js)
 *  can show the same bar while the page reloads instead of an empty strip. Null if there is none. */
function snapshotTitleBar(): string | null {
    const source = document.querySelector("[data-app-titlebar]");
    if (!source) return null;
    const copy = source.cloneNode(true) as Element;
    const inline = (from: Element, to: Element) => {
        const style = getComputedStyle(from);
        to.setAttribute("style", SNAPSHOT_PROPS.map(p => `${p}:${style.getPropertyValue(p)}`).join(";"));
        to.removeAttribute("class");
        for (let i = 0; i < from.children.length; i++) inline(from.children[i], to.children[i]);
    };
    inline(source, copy);
    return copy.outerHTML;
}
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
    try {
        const bar = snapshotTitleBar();
        if (bar) sessionStorage.setItem(BAR_KEY, bar);
    } catch { /* no snapshot: the switching screen draws a plain bar */ }
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
