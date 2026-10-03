import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { BookA, Plus, X } from 'lucide-react';
import { useWorkspace } from '../../hooks/useWorkspace';
import type { GlossaryTerm } from '../../api';
import { resolveEntry, termKinds } from '../../lib/glossary';
import { builtInTagIcon, builtInTagRank } from '../../lib/built-in-tags';
import { AddQuickTagModal } from '../AddQuickTagModal';

interface Props {
    /** 'terms' = glossary entries with a definition; 'tags' = Quick Tags (no definition). */
    kind: 'terms' | 'tags';
    videoTags: string[];
    /** `kind="terms"` only: the terms linked in whichever of the transcript/AI Summary is currently
     *  being read (see Sidebar.tsx and lib/internal-links.ts's `findGlossaryTerms`) — this, not
     *  `videoTags`, is what the Terms chip list actually shows; `videoTags` still carries the
     *  persisted union of both (see sync_terms_from_video_text) for Library search/export/sync, but
     *  the panel only ever shows what's linked in the text on screen right now. */
    detectedTerms?: string[];
    /** Every Glossary row (one per term per Drive). A term is listed once here, whichever Drives define it. */
    glossaryTerms: GlossaryTerm[];
    /** The video's own Drives: which Drive's definition a term with several opens (see lib/glossary.ts). */
    preferredDrives?: string[];
    onAddTag?: (term: string) => void;
    onRemoveTag?: (term: string) => void;
    /** `kind="tags"` only: opens the resolved entry's definition. */
    onSelectTerm: (term: GlossaryTerm) => void;
    /** `kind="terms"` only: jumps to and highlights that term's link in the AI Summary. Takes the
     *  raw name, not a resolved GlossaryTerm — a linked term doesn't need a formal Glossary entry
     *  (a definition) to exist yet in order to jump to it. */
    onJumpToTerm?: (term: string) => void;
    /** Terms to list first in the add dropdown (the ones filed under the video's Drive), with
     *  `priorityLabel` naming that Drive. Everything else follows under "All". Omit for no grouping. */
    priorityTerms?: Set<string>;
    priorityLabel?: string;
    /** False = read-only: tags are shown and open their definition, but can't be added or removed
     *  (a DB owner's allowEditTermsAndTags flag — one flag for both, since this is the same component
     *  for either tab). */
    canEdit?: boolean;
    onGlossaryChanged?: () => void;
    /** `kind="tags"` only: the dropdown's "Manage tags in <Glossary>", which goes to the Glossary's tags list. */
    onManageTags?: () => void;
}

/** Displays a video's terms or tags as chips. Tags keep the "add" dropdown/remove-X pair filtered
 *  to the ones not already applied, and a chip click opens its definition (via `onSelectTerm`).
 *  Terms are read-only: they're auto-detected from `[Text](kinesis://glossary/Text)` links in
 *  whichever of the transcript/AI Summary is on screen (`detectedTerms`, computed by Sidebar.tsx),
 *  not something added or removed here — a chip click instead jumps to and highlights that link
 *  (`onJumpToTerm`). The dropdown closes on an outside click. Renders just the tag row — the
 *  surrounding card/header is owned by Sidebar.tsx's Tags/Similar Videos tab switcher. */
export function VideoTagsPanel({ kind, videoTags, detectedTerms, glossaryTerms, preferredDrives, onAddTag, onRemoveTag, onSelectTerm, onJumpToTerm, priorityTerms, priorityLabel, canEdit = true, onGlossaryChanged, onManageTags }: Props) {
    const noun = kind === 'terms' ? 'term' : 'tag';
    const { labels } = useWorkspace();
    // Terms are never user-editable any more — see the doc comment above.
    const editable = canEdit && kind === 'tags';
    // A Quick Tag is a name with no definition in any Drive; a term has one in at least one.
    const ofKind = useMemo(
        () => [...termKinds(glossaryTerms)].filter(([, isTerm]) => isTerm === (kind === 'terms')).map(([name]) => name),
        [glossaryTerms, kind],
    );
    const [showTagDropdown, setShowTagDropdown] = useState(false);
    const [showCreateTagModal, setShowCreateTagModal] = useState(false);
    const [tagFilter, setTagFilter] = useState("");
    const plusRef = useRef<HTMLButtonElement>(null);
    // Where the open dropdown sits, in window coordinates (see `place`).
    const [menuPos, setMenuPos] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);

    const handleClickOutside = useCallback((e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (showTagDropdown && !target.closest('.tag-dropdown-container')) {
            setShowTagDropdown(false);
            setTagFilter("");
        }
    }, [showTagDropdown]);

    // The list is drawn on the page itself (a portal), not inside the sidebar: the sidebar's own
    // layers (its header and player) would otherwise sit over it, and its edges would clip it. It's
    // placed from the + button's spot: above it when there's room (or more room than below), else
    // below, its height limited to the space there, and kept inside the window sideways.
    const place = useCallback(() => {
        const button = plusRef.current;
        if (!button) return;
        const r = button.getBoundingClientRect();
        const margin = 8;
        const width = 240;
        const left = Math.min(Math.max(r.left, margin), Math.max(margin, window.innerWidth - width - margin));
        const above = r.top - margin * 2;
        const below = window.innerHeight - r.bottom - margin * 2;
        const wanted = Math.min(520, window.innerHeight * 0.6);
        const up = above >= Math.min(wanted, 240) || above >= below;
        const room = Math.max(120, up ? above : below);
        setMenuPos(up
            ? { left, bottom: window.innerHeight - r.top + margin, maxHeight: Math.min(wanted, room) }
            : { left, top: r.bottom + margin, maxHeight: Math.min(wanted, room) });
    }, []);
    useEffect(() => {
        if (!showTagDropdown) { setMenuPos(null); return; }
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
        };
    }, [showTagDropdown, place]);

    useEffect(() => {
        if (showTagDropdown) {
            document.addEventListener('click', handleClickOutside);
            return () => document.removeEventListener('click', handleClickOutside);
        }
    }, [showTagDropdown, handleClickOutside]);

    // Terms: exactly what's linked in the text on screen, in reading order (not alphabetized — that
    // order matches jumping to them top-to-bottom). Tags: everything applied, in the dropdown's order: the built-in
    // ones first in their own order, then the rest alphabetized.
    const tagOrder = (a: string, b: string) => {
        const [ra, rb] = [builtInTagRank(a), builtInTagRank(b)];
        if (ra >= 0 || rb >= 0) return ra < 0 ? 1 : rb < 0 ? -1 : ra - rb;
        return a.localeCompare(b);
    };
    const filtered = kind === 'terms' ? (detectedTerms ?? []) : [...videoTags].filter(tag => ofKind.includes(tag)).sort(tagOrder);
    const availableTerms = ofKind.filter(name =>
        !videoTags.includes(name) &&
        name.toLowerCase().includes(tagFilter.toLowerCase())
    ).sort((a, b) => a.localeCompare(b));
    // The video's Drive's own terms go first; the rest follow without repeating them.
    const prioritized = priorityTerms ? availableTerms.filter(name => priorityTerms.has(name)) : [];
    const others = priorityTerms ? availableTerms.filter(name => !priorityTerms.has(name)) : availableTerms;
    // Tags: the built-in ones (Watch Later, Favorite, ...) first, in their own order and with their icons, then the
    // rest under "Custom".
    const essentials = kind === 'tags'
        ? others.filter(name => builtInTagRank(name) >= 0).sort((a, b) => builtInTagRank(a) - builtInTagRank(b))
        : [];
    const custom = kind === 'tags' ? others.filter(name => builtInTagRank(name) < 0) : others;
    // A label with a rule running out to the right ("IN :UAP ────"), in the dropdown's own border colour.
    const groupHeader = (text: string) => (
        <div className="flex items-center gap-2 px-4 pt-3 pb-1 select-none">
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-[#aaaaaa]">{text}</span>
            <span className="flex-1 h-px bg-[#383838]" />
        </div>
    );
    const termButton = (name: string) => {
        const Icon = kind === 'tags' ? builtInTagIcon(name) : undefined;
        return (
            <button
                key={name}
                onClick={() => {
                    onAddTag?.(name);
                    setShowTagDropdown(false);
                    setTagFilter("");
                }}
                className="w-full flex items-center gap-2 text-left px-4 py-2 text-[11px] text-white hover:bg-[#2a2a2a] transition-colors cursor-pointer rounded"
            >
                {/* Up a pixel: the text's line keeps room below for descenders, so its letters sit above its middle. */}
                {Icon && <Icon className="w-3 h-3 shrink-0 -translate-y-px text-[#aaaaaa]" />}
                {name}
            </button>
        );
    };

    return (
            // A video can have dozens of terms: past this height the chips scroll, as the Similar Videos list does.
            <div className="flex flex-wrap items-center gap-1.5 max-h-[280px] overflow-y-auto custom-scrollbar pr-1">
                {filtered.map((tag) => {
                    // A built-in tag's chip stands out: its icon, and a thicker border (the padding gives back the extra
                    // pixel, so every chip stays the same height).
                    const BuiltInIcon = kind === 'tags' ? builtInTagIcon(tag) : undefined;
                    return (
                    <button
                        key={tag}
                        onClick={(e) => {
                            e.stopPropagation();
                            if (kind === 'terms') {
                                // Jumps to the link in the Summary — works even for a name that's
                                // linked there but has no formal Glossary definition yet.
                                onJumpToTerm?.(tag);
                                return;
                            }
                            const term = resolveEntry(glossaryTerms, tag, preferredDrives);
                            if (term) {
                                onSelectTerm(term);
                            }
                        }}
                        className={`group flex items-center gap-1 bg-[#222222] rounded-md text-[11px] text-white hover:bg-[#333333] transition-all cursor-pointer ${BuiltInIcon ? 'px-[9px] py-[3px] border-2 border-[#505050]' : 'px-2.5 py-1 border border-[#383838]'}`}
                    >
                        {BuiltInIcon && <BuiltInIcon className="w-3 h-3 shrink-0 -translate-y-px text-[#aaaaaa]" />}
                        {tag}
                        {editable && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onRemoveTag?.(tag);
                            }}
                            className="text-[#666666] hover:text-red-500 transition-colors ml-1 cursor-pointer"
                        >
                            <X className="w-3 h-3" />
                        </button>
                        )}
                    </button>
                    );
                })}

                {editable && filtered.length === 0 && (
                    <span className="text-[11px] text-[#666666] font-medium italic select-none">
                        Add a {noun}
                    </span>
                )}
                {kind === 'terms' && filtered.length === 0 && (
                    <span className="text-[11px] text-[#666666] font-medium italic select-none">
                        No terms linked yet
                    </span>
                )}

                {editable && (
                <div className="relative tag-dropdown-container">
                    <button
                        ref={plusRef}
                        onClick={(e) => {
                            e.stopPropagation();
                            setShowTagDropdown(!showTagDropdown);
                        }}
                        className="flex items-center justify-center w-6 h-6 bg-[#222222] border border-[#383838] rounded-md text-[10px] text-[#888888] hover:text-white hover:border-[#555555] transition-all cursor-pointer"
                    >
                        <Plus className="w-3 h-3" />
                    </button>

                    {showTagDropdown && menuPos && createPortal(
                        // tag-dropdown-container: the outside-click check treats a click in here as inside.
                        <div
                            className="tag-dropdown-container fixed bg-[#1a1a1a] border border-[#383838] rounded-lg overflow-hidden flex flex-col z-[150] w-[240px]"
                            style={{ left: menuPos.left, top: menuPos.top, bottom: menuPos.bottom, maxHeight: menuPos.maxHeight }}
                        >
                            <div className="p-3 border-b border-[#303030] bg-white/5">
                                <input
                                    type="text"
                                    placeholder={`Filter ${noun}s...`}
                                    value={tagFilter}
                                    onChange={(e) => setTagFilter(e.target.value)}
                                    className="w-full bg-[#222222] border border-[#383838] rounded-md px-3 py-1.5 text-[11px] text-white placeholder-[#666666] focus:outline-none focus:border-red-500"
                                    autoFocus
                                    onClick={(e) => e.stopPropagation()}
                                />
                            </div>
                            {/* Fills what's left under the filter box, instead of a fixed 150px. */}
                            <div className="overflow-y-auto flex-1 min-h-0 custom-scrollbar p-1">
                                {availableTerms.length === 0 ? (
                                    <p className="p-4 text-[11px] text-[#666666] text-center italic">
                                        {tagFilter ? `No matching ${noun}s` : `No ${noun}s available`}
                                    </p>
                                ) : (
                                    <>
                                        {prioritized.length > 0 && (
                                            <>
                                                {groupHeader(`In ${priorityLabel}`)}
                                                {prioritized.map(termButton)}
                                                {others.length > 0 && groupHeader(`All ${noun}s`)}
                                            </>
                                        )}
                                        {/* Headings only when both groups have something to show. */}
                                        {essentials.length > 0 && custom.length > 0 && groupHeader('Essentials')}
                                        {essentials.map(termButton)}
                                        {essentials.length > 0 && custom.length > 0 && groupHeader('Custom')}
                                        {custom.map(termButton)}
                                    </>
                                )}
                            </div>
                            <div className="shrink-0 border-t border-[#303030] p-1">
                                <button
                                    onClick={() => {
                                        setShowTagDropdown(false);
                                        setTagFilter('');
                                        setShowCreateTagModal(true);
                                    }}
                                    className="w-full flex items-center gap-2 px-4 py-2 text-left text-[11px] font-semibold text-gray-300 hover:bg-[#2a2a2a] hover:text-white transition-colors cursor-pointer rounded"
                                >
                                    <Plus className="w-3.5 h-3.5" />
                                    Create new tag
                                </button>
                                {kind === 'tags' && onManageTags && (
                                    <button
                                        onClick={() => {
                                            setShowTagDropdown(false);
                                            setTagFilter('');
                                            onManageTags();
                                        }}
                                        className="w-full flex items-center gap-2 px-4 py-2 text-left text-[11px] font-semibold text-gray-300 hover:bg-[#2a2a2a] hover:text-white transition-colors cursor-pointer rounded"
                                    >
                                        <BookA className="w-3.5 h-3.5" />
                                        Manage tags in {labels.aliasGlossary}
                                    </button>
                                )}
                            </div>
                        </div>,
                        document.body,
                    )}
                </div>
                )}
                {showCreateTagModal && (
                    <AddQuickTagModal
                        onClose={() => setShowCreateTagModal(false)}
                        onCreated={tag => {
                            setShowCreateTagModal(false);
                            onGlossaryChanged?.();
                            onAddTag?.(tag);
                        }}
                    />
                )}
            </div>
    );
}
