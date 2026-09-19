import { defaultUrlTransform } from 'react-markdown';
import type { WorkspaceLabels } from './workspace';

/**
 * In-app links inside markdown, like `[Halving](kinesis://glossary/Halving)`. The address carries
 * the target's natural key, percent-encoded, so the link means the same in a shared or synced
 * database. Written by the Ctrl+Shift+K picker (components/LinkPicker.tsx), opened by the app
 * (App.tsx registers the handler below), tidied when a target goes away and turned into wiki links on
 * Obsidian export (src-tauri/src/db/links.rs, which reads the same format).
 */

export type LinkKind = 'glossary' | 'bio' | 'video' | 'drive';

export const LINK_SCHEME = 'kinesis://';

/** What a kind of link is called in the UI, following the workspace's aliases (e.g. "Thesaurus", "Creators"). */
export function linkKindLabel(kind: LinkKind, labels: WorkspaceLabels): string {
    switch (kind) {
        case 'glossary': return labels.aliasGlossary;
        case 'bio': return labels.aliasBiography;
        case 'drive': return labels.aliasDriveName;
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

export function parseInternalHref(href: string | undefined | null): { kind: LinkKind; key: string } | null {
    const m = /^kinesis:\/\/(glossary|bio|video|drive)\/(.+)$/.exec(href ?? '');
    if (!m) return null;
    try {
        return { kind: m[1] as LinkKind, key: decodeURIComponent(m[2]) };
    } catch {
        return null;
    }
}

/** react-markdown drops URLs whose scheme it doesn't know, so in-app links are let through. */
export function markdownUrlTransform(url: string): string {
    return url.startsWith(LINK_SCHEME) ? url : defaultUrlTransform(url);
}

// ── Opening links ────────────────────────────────────────────────────────────

type LinkHandler = (kind: LinkKind, key: string) => void;
let handler: LinkHandler | null = null;

/** App registers what a click on an in-app link does. Returns a function that unregisters it. */
export function setInternalLinkHandler(fn: LinkHandler | null): () => void {
    handler = fn;
    return () => { if (handler === fn) handler = null; };
}

export function openInternalLink(kind: LinkKind, key: string) {
    handler?.(kind, key);
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
