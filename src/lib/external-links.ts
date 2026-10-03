import { openExternalUrl } from "../api";

type ExternalLinkGuard = (url: string, title: string) => void;

let guard: ExternalLinkGuard | null = null;

/** App registers the handler that confirms before opening an external site. Returns an unregister function. */
export function setExternalLinkGuard(fn: ExternalLinkGuard | null): () => void {
    guard = fn;
    return () => { if (guard === fn) guard = null; };
}

/** True for http/https URLs — the only ones that get the warning dialog. Other schemes
 *  (e.g. "kinesis://") open straight through without confirmation. */
export function isExternalUrl(url: string): boolean {
    return /^https?:\/\//i.test(url);
}

/** Opens `url`, asking first if it's an external website and a guard has been registered.
 *  Non-http URLs (like kinesis://) and un-guarded calls skip the prompt and open directly. */
export function openExternalUrlGuarded(url: string, title?: string): void {
    if (!isExternalUrl(url)) { void openExternalUrl(url); return; }
    if (guard) { guard(url, title ?? url); } else { void openExternalUrl(url); }
}
