import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownUrlTransform, openInternalLink } from '../lib/internal-links';
import { getBiography, type GlossaryTerm } from '../api';
import { glossaryPreview } from '../lib/glossary-preview';
import { inlineMarkdown } from '../lib/preview-markdown';
import { remarkHighlight } from '../lib/remark-highlight';
import { FloatingCard, type Side } from './FloatingCard';

const HOVER_MS = 350;
/** How long the pointer can be off both the element and an interactive card before it closes (crossing the gap between
 *  them takes a moment, and shouldn't count as leaving). */
const LEAVE_MS = 250;

/** The preview's text: the entry reduced to inline markdown (lib/preview-markdown.ts), shown with its bold, italics,
 *  strikethrough, highlight and inline code. Links keep their color and underline but are only text here, since the card
 *  can't be clicked. Everything sits in one flow so the card can cut it off with an ellipsis. */
function PreviewMarkdown({ children }: { children: string }) {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkHighlight]}
            urlTransform={markdownUrlTransform}
            components={{
                p: ({ children }) => <>{children}</>,
                a: ({ children }) => <span className="text-red-400 underline decoration-dotted decoration-red-400/60 underline-offset-2">{children}</span>,
                strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
                mark: ({ children }) => <mark className="rounded-sm bg-yellow-400/25 px-0.5 text-inherit">{children}</mark>,
                code: ({ children }) => <code className="rounded bg-black/40 px-1 font-mono text-[12px] text-red-300">{children}</code>,
            }}
        >
            {children}
        </ReactMarkdown>
    );
}

/** A card with a title and the start of some markdown text, cut off with an ellipsis after six lines: a detailed entry shows its
 *  opening, and the rest is one click away. `side` is where it goes around `anchor` (flipped if there is no room). */
export function SnippetCard({ anchor, title, markdown, onOpen, side = 'auto', copyText, onMouseEnter, onMouseLeave, zIndex }: {
    anchor: DOMRect; title: string; markdown: string; side?: Side | 'auto';
    /** With this, the bottom row reads "Open" and opens the entry when clicked (rather than only the hovered element doing so). */
    onOpen?: () => void;
    /** With this, the card can be moved onto and has a button that copies this text (the whole entry, where the card shows its start,
     *  as real markdown rather than the flattened preview text). */
    copyText?: string; onMouseEnter?: () => void; onMouseLeave?: () => void; zIndex?: number;
}) {
    const [copied, setCopied] = useState(false);
    const copy = () => {
        navigator.clipboard?.writeText(copyText ?? '').then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
    };
    return (
        <FloatingCard anchor={anchor} side={side} zIndex={zIndex} interactive={copyText !== undefined} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} className="w-80 max-w-[calc(100vw-1rem)] px-3.5 py-3 text-left">
            <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0 text-sm font-semibold text-white leading-snug">{title}</div>
                {copyText !== undefined && (
                    <button
                        type="button"
                        onClick={copy}
                        title={copied ? 'Copied' : 'Copy all of it (as markdown)'}
                        aria-label="Copy"
                        className={`shrink-0 mt-1 cursor-pointer transition-colors ${copied ? 'text-green-400' : 'text-gray-500 hover:text-white'}`}
                    >
                        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    </button>
                )}
            </div>
            <div className="mt-1.5 text-[13px] leading-snug text-gray-300 whitespace-pre-line [overflow-wrap:anywhere] line-clamp-6"><PreviewMarkdown>{markdown}</PreviewMarkdown></div>
            {onOpen && (
                <button
                    type="button"
                    onClick={onOpen}
                    // pointer-events-auto: works even when the card itself doesn't take the pointer (no copy button, so
                    // moving onto the card isn't otherwise supported).
                    className="mt-2 pointer-events-auto text-[11px] text-gray-500 hover:text-white transition-colors cursor-pointer"
                >
                    Open
                </button>
            )}
        </FloatingCard>
    );
}

/** What a preview card shows: a title, the start of some markdown text under it, and, when it can be copied, the real
 *  markdown behind that preview (the full entry, not cut short). */
interface PreviewContent {
    title: string;
    markdown: string;
    copyText?: string;
    /** Opens the entry itself; shown as a small "Open" at the bottom of the card, clickable there directly. */
    onOpen?: () => void;
}

interface PreviewOptions {
    /** Where the card opens around the hovered element. Defaults to below/above (an inline link's usual spot). */
    side?: Side | 'auto';
    /** Overrides the default layer when this preview must appear above a modal. */
    zIndex?: number;
}

/**
 * The hover preview machinery: wire the returned `handlers` to an element and render `card` beside it. `load` says what
 * the card holds (null for nothing to show, so no card opens). It opens once the pointer has rested on the element for a
 * moment. With `copyText` in what `load` returns, the card can be moved onto (to use its copy button): it then closes only
 * once the pointer has been off both the element and the card for a moment, rather than the instant either is left; without
 * it, leaving the element closes it at once, same as any tooltip. Also closes on a click, or when anything scrolls.
 */
function usePreviewCard(load: () => Promise<PreviewContent | null>, { side, zIndex }: PreviewOptions = {}) {
    const [open, setOpen] = useState<{ rect: DOMRect; content: PreviewContent } | null>(null);
    const openTimer = useRef(0);
    const leaveTimer = useRef(0);
    const attempt = useRef(0);

    const closeNow = () => {
        window.clearTimeout(openTimer.current);
        window.clearTimeout(leaveTimer.current);
        attempt.current++;
        setOpen(null);
    };
    useEffect(() => {
        if (!open) return;
        // A pointerdown on the card itself (its copy or Open button, marked data-keep-open by FloatingCard when
        // interactive) doesn't count as "elsewhere": closing here first would take the card away before its own
        // click handler ever saw the press.
        const away = (e: Event) => { if (!(e.target as Element)?.closest?.('[data-keep-open]')) closeNow(); };
        document.addEventListener('scroll', closeNow, true);
        document.addEventListener('pointerdown', away, true);
        window.addEventListener('blur', closeNow);
        return () => {
            document.removeEventListener('scroll', closeNow, true);
            document.removeEventListener('pointerdown', away, true);
            window.removeEventListener('blur', closeNow);
        };
    }, [open]);
    useEffect(() => closeNow, []);

    // Entering the element or (once open) the card cancels a pending close.
    const stay = () => window.clearTimeout(leaveTimer.current);
    // Leaving either closes it after LEAVE_MS, unless the pointer has moved onto the other one by then (which calls stay()).
    const leaveSoon = () => {
        window.clearTimeout(leaveTimer.current);
        leaveTimer.current = window.setTimeout(closeNow, LEAVE_MS);
    };

    const handlers = {
        onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
            stay();
            const el = e.currentTarget;
            const id = ++attempt.current;
            window.clearTimeout(openTimer.current);
            openTimer.current = window.setTimeout(() => {
                load().then(content => {
                    // The pointer may have moved on (and back, opening a new attempt) while this one was fetched.
                    if (content && attempt.current === id && el.isConnected) setOpen({ rect: el.getBoundingClientRect(), content });
                }).catch(() => {});
            }, HOVER_MS);
        },
        onMouseLeave: leaveSoon,
    };

    const card = open && (
        <SnippetCard
            anchor={open.rect}
            side={side}
            title={open.content.title}
            markdown={open.content.markdown}
            copyText={open.content.copyText}
            zIndex={zIndex}
            onOpen={open.content.onOpen && (() => { open.content.onOpen!(); closeNow(); })}
            onMouseEnter={open.content.copyText !== undefined ? stay : undefined}
            onMouseLeave={open.content.copyText !== undefined ? leaveSoon : undefined}
        />
    );

    return { handlers, card };
}

/** The hover preview for an in-app glossary link (in a transcript, a summary, another entry): the term and the start of
 *  its definition, cut off with an ellipsis where it runs long. Its "Open" opens the term the same way clicking the link
 *  does. */
export function useGlossaryPreview(term: string) {
    return usePreviewCard(async () => {
        if (!term) return null;
        const found = await glossaryPreview(term);
        return found ? { title: found.term, markdown: found.markdown, copyText: found.raw, onOpen: () => openInternalLink('glossary', term) } : null;
    });
}

/** The hover preview for a row in the Glossary list: a term's definition (this row's own, so a term filed differently per
 *  Drive previews the right one), opening to the right so it clears the list. A Quick Tag has no definition, so it has no
 *  preview. The card can be moved onto to use its copy button (the definition, as markdown), and its "Open" does what
 *  clicking the row itself does. */
export function useEntryPreview(entry: GlossaryTerm, onOpen: () => void) {
    return usePreviewCard(async () => (
        entry.definition.trim() === '' ? null : { title: entry.term, markdown: inlineMarkdown(entry.definition, entry.term), copyText: entry.definition, onOpen }
    ), { side: 'right' });
}

/** The hover preview for a person in the Biography list: the description from their biography, opening to the right, and
 *  only if they have one. The card can be moved onto to use its copy button (the description, as markdown), and its "Open"
 *  does what clicking the row itself does. */
export function useBioPreview(person: { handle: string; displayName: string; bio: string }, onOpen: () => void) {
    return usePreviewCard(async () => (
        person.bio.trim() === '' ? null : { title: person.displayName.trim() || person.handle, markdown: inlineMarkdown(person.bio, person.displayName), copyText: person.bio, onOpen }
    ), { side: 'right' });
}

/** Like useBioPreview, for a link to a person (`kinesis://bio/handle`), which only has the handle: the biography is looked
 *  up when the pointer rests on it. Its "Open" opens the biography the same way clicking the link does. */
export function useBioLinkPreview(handle: string, options?: PreviewOptions) {
    return usePreviewCard(async () => {
        if (!handle) return null;
        const person = await getBiography(handle);
        return person && person.bio.trim() !== ''
            ? { title: person.displayName.trim() || person.handle, markdown: inlineMarkdown(person.bio, person.displayName), copyText: person.bio, onOpen: () => openInternalLink('bio', handle) }
            : null;
    }, options);
}
