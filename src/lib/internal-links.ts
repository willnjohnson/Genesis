import { defaultUrlTransform } from 'react-markdown';
import type { WorkspaceLabels } from './workspace';
import { formatClock, parseClock } from './remark-timestamps';

/**
 * In-app links inside markdown, like `[Halving](kinesis://glossary/Halving)`. The address carries
 * the target's natural key, percent-encoded, so the link means the same in a shared or synced
 * database. Written by the Ctrl+Shift+K picker (components/LinkPicker.tsx), opened by the app
 * (App.tsx registers the handler below), tidied when a target goes away and turned into wiki links on
 * Obsidian export (src-tauri/src/db/links.rs, which reads the same format).
 */

/** 'playlist' is a Drive's playlist (its sequence, in the code), keyed by the Drive's display path (":CS-DSA"): it opens whatever video is first in it
 *  at the time, so reordering never breaks the link. */
export type LinkKind = 'glossary' | 'bio' | 'video' | 'drive' | 'playlist';

export const LINK_SCHEME = 'kinesis://';

/** What a kind of link is called in the UI, following the workspace's aliases (e.g. "Thesaurus", "Creators"). */
export function linkKindLabel(kind: LinkKind, labels: WorkspaceLabels): string {
    switch (kind) {
        case 'glossary': return labels.aliasGlossary;
        case 'bio': return labels.aliasBiography;
        case 'drive': return labels.aliasDriveName;
        case 'playlist': return labels.aliasSequence;
        default: return 'Video';
    }
}

/** Percent-encodes a key like the backend does: everything but letters, digits and -_.~ is
 *  encoded, parentheses included, so a key such as "Bitcoin (BTC)" can't end the markdown link early. */
export function encodeLinkKey(key: string): string {
    return encodeURIComponent(key).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** The link text can't contain brackets or line breaks. */
function cleanLinkText(text: string): string {
    return text.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
}

export function buildLink(text: string, kind: LinkKind, key: string): string {
    return `[${cleanLinkText(text)}](${LINK_SCHEME}${kind}/${encodeLinkKey(key)})`;
}

/** An in-app link's kind and key. A video link can also carry where to start (`?t=1:23`, `?t=83`), as `at` in seconds:
 *  it isn't part of the key, so it's still a link to that video (db/links.rs reads it the same way). */
/** A link to a video, starting at `at` seconds when it's given and past the start (`?t=1:23`, see parseInternalHref). */
export function buildVideoLink(text: string, videoId: string, at?: number): string {
    const link = buildLink(text, 'video', videoId);
    return at && at >= 1 ? `${link.slice(0, -1)}?t=${formatClock(Math.floor(at))})` : link;
}

export function parseInternalHref(href: string | undefined | null): { kind: LinkKind; key: string; at?: number } | null {
    const m = /^kinesis:\/\/(glossary|bio|video|drive|playlist)\/(.+?)(?:\?t=([0-9:]+))?$/.exec(href ?? '');
    if (!m) return null;
    const at = m[3] !== undefined ? parseClock(m[3]) : null;
    // Only a video starts somewhere (anything else with a time isn't a link, as in db/links.rs). On a video, a time
    // that isn't a real one ("1:99") is ignored: the link still opens the video, from wherever it would.
    if (m[3] !== undefined && m[1] !== 'video') return null;
    try {
        return { kind: m[1] as LinkKind, key: decodeURIComponent(m[2]), ...(at !== null ? { at } : {}) };
    } catch {
        return null;
    }
}

/** Every unique glossary term linked (`[Text](kinesis://glossary/Term)`) in raw markdown `text`, in
 *  the order first seen — the Sidebar's Terms panel uses this to show whichever of the transcript
 *  or the AI Summary is currently being read (see Sidebar.tsx), and the same detection backs what
 *  actually gets persisted to Videos.tags server-side (src-tauri/src/db/summaries.rs's
 *  `sync_terms_from_video_text`, which finds these the same way via db/links.rs's `find_links`). */
export function findGlossaryTerms(text: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of text.matchAll(/\[[^[\]]*\]\(kinesis:\/\/glossary\/([A-Za-z0-9\-._~%]+)\)/g)) {
        try {
            const key = decodeURIComponent(m[1]);
            if (!seen.has(key)) {
                seen.add(key);
                out.push(key);
            }
        } catch {
            // Malformed percent-encoding: skip rather than throw.
        }
    }
    return out;
}

/** react-markdown drops URLs whose scheme it doesn't know, so in-app links are let through. */
export function markdownUrlTransform(url: string): string {
    return url.startsWith(LINK_SCHEME) ? url : defaultUrlTransform(url);
}

// ── Opening links ────────────────────────────────────────────────────────────

/** The shortcut for a timed video link, a [1:23] timestamp straight after the link, as it's written in text: the
 *  link's address, its closing parenthesis, and the time. Never one that already has a time. */
const VIDEO_LINK_THEN_TIME = /(\]\(kinesis:\/\/video\/[A-Za-z0-9\-._~%]+)\)\[((?:\d{1,2}:[0-5]\d|\d{1,3}):[0-5]\d)\]/g;

/** Folds that shortcut into the link: `[Talk](kinesis://video/ID)[1:23]` becomes `[Talk](kinesis://video/ID?t=1:23)`, the
 *  one form the rest of the app reads. Run on what's saved (the Sidebar's transcript and summary). */
export function foldVideoLinkTimes(text: string): string {
    if (!text.includes('kinesis://video/')) return text;
    return text.replace(VIDEO_LINK_THEN_TIME, (whole, link: string, time: string) => (parseClock(time) === null ? whole : `${link}?t=${time})`));
}

/** `at`: where a video link starts, in seconds (see parseInternalHref). */
type LinkHandler = (kind: LinkKind, key: string, at?: number) => void;
let handler: LinkHandler | null = null;

/** App registers what a click on an in-app link does. Returns a function that unregisters it. */
export function setInternalLinkHandler(fn: LinkHandler | null): () => void {
    handler = fn;
    return () => { if (handler === fn) handler = null; };
}

export function openInternalLink(kind: LinkKind, key: string, at?: number) {
    handler?.(kind, key, at);
}

// ── Asking for the picker ────────────────────────────────────────────────────

export const LINK_PICKER_EVENT = 'kinesis:link-picker';

export interface LinkPickerRequest {
    textarea: HTMLTextAreaElement;
    /** The selection when the shortcut was pressed. */
    start: number;
    end: number;
}

/** Called by the editor shortcut (lib/markdown-editor.ts); the single LinkPicker in App answers it. */
export function requestLinkPicker(request: LinkPickerRequest) {
    window.dispatchEvent(new CustomEvent<LinkPickerRequest>(LINK_PICKER_EVENT, { detail: request }));
}
