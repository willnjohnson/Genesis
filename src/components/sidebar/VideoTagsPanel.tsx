import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, X } from 'lucide-react';
import type { GlossaryTerm } from '../../api';
import { resolveEntry, termKinds } from '../../lib/glossary';

interface Props {
    /** 'terms' = glossary entries with a definition; 'tags' = Quick Tags (no definition). */
    kind: 'terms' | 'tags';
    videoTags: string[];
    /** Every Glossary row (one per term per Drive). A term is listed once here, whichever Drives define it. */
    glossaryTerms: GlossaryTerm[];
    /** The video's own Drives: which Drive's definition a term with several opens (see lib/glossary.ts). */
    preferredDrives?: string[];
    onAddTag?: (term: string) => void;
    onRemoveTag?: (term: string) => void;
    onSelectTerm: (term: GlossaryTerm) => void;
    /** Terms to list first in the add dropdown (the ones filed under the video's Drive), with
     *  `priorityLabel` naming that Drive. Everything else follows under "All". Omit for no grouping. */
    priorityTerms?: Set<string>;
    priorityLabel?: string;
    /** False = read-only: tags are shown and open their definition, but can't be added or removed
     *  (a DB owner's allowEditTermsAndTags flag — one flag for both, since this is the same component
     *  for either tab). */
    canEdit?: boolean;
}

/** Displays a video's terms or tags (as chips, per `kind`) plus an "add" dropdown filtered to
 *  the ones not already applied. Clicking a chip opens its term definition (via
 *  `onSelectTerm`); the dropdown closes on an outside click. Renders just the tag row — the
 *  surrounding card/header is owned by Sidebar.tsx's Tags/Similar Videos tab switcher. */
export function VideoTagsPanel({ kind, videoTags, glossaryTerms, preferredDrives, onAddTag, onRemoveTag, onSelectTerm, priorityTerms, priorityLabel, canEdit = true }: Props) {
    const noun = kind === 'terms' ? 'term' : 'tag';
    // A Quick Tag is a name with no definition in any Drive; a term has one in at least one.
    const ofKind = useMemo(
        () => [...termKinds(glossaryTerms)].filter(([, isTerm]) => isTerm === (kind === 'terms')).map(([name]) => name),
        [glossaryTerms, kind],
    );
    const [showTagDropdown, setShowTagDropdown] = useState(false);
    const [tagFilter, setTagFilter] = useState("");

    const handleClickOutside = useCallback((e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (showTagDropdown && !target.closest('.tag-dropdown-container')) {
            setShowTagDropdown(false);
            setTagFilter("");
        }
    }, [showTagDropdown]);

    useEffect(() => {
        if (showTagDropdown) {
            document.addEventListener('click', handleClickOutside);
            return () => document.removeEventListener('click', handleClickOutside);
        }
    }, [showTagDropdown, handleClickOutside]);

    const filtered = [...videoTags].filter(tag => ofKind.includes(tag)).sort((a, b) => a.localeCompare(b));
    const availableTerms = ofKind.filter(name =>
        !videoTags.includes(name) &&
        name.toLowerCase().includes(tagFilter.toLowerCase())
    ).sort((a, b) => a.localeCompare(b));
    // The video's Drive's own terms go first; the rest follow without repeating them.
    const prioritized = priorityTerms ? availableTerms.filter(name => priorityTerms.has(name)) : [];
    const others = priorityTerms ? availableTerms.filter(name => !priorityTerms.has(name)) : availableTerms;
    // A label with a rule running out to the right ("IN :UAP ────"), in the dropdown's own border colour.
    const groupHeader = (text: string) => (
        <div className="flex items-center gap-2 px-4 pt-3 pb-1 select-none">
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-[#aaaaaa]">{text}</span>
            <span className="flex-1 h-px bg-[#383838]" />
        </div>
    );
    const termButton = (name: string) => (
        <button
            key={name}
            onClick={() => {
                onAddTag?.(name);
                setShowTagDropdown(false);
                setTagFilter("");
            }}
            className="w-full text-left px-4 py-2 text-[11px] text-white hover:bg-[#2a2a2a] transition-colors cursor-pointer rounded"
        >
            {name}
        </button>
    );

    return (
            <div className="flex flex-wrap items-center gap-1.5">
                {filtered.map((tag) => (
                    <button
                        key={tag}
                        onClick={(e) => {
                            e.stopPropagation();
                            // A term with a definition per Drive opens the one for this video's Drive.
                            const rows = kind === 'terms' ? glossaryTerms.filter(t => t.definition.trim() !== '') : glossaryTerms;
                            const term = resolveEntry(rows, tag, preferredDrives);
                            if (term) {
                                onSelectTerm(term);
                            }
                        }}
                        className="group flex items-center gap-1 px-2.5 py-1 bg-[#222222] border border-[#383838] rounded-md text-[11px] text-white hover:bg-[#333333] transition-all cursor-pointer"
                    >
                        {tag}
                        {canEdit && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onRemoveTag?.(tag);
                            }}
                            className="text-[#666666] hover:text-red-500 transition-colors ml-1"
                        >
                            <X className="w-3 h-3" />
                        </button>
                        )}
                    </button>
                ))}

                {canEdit && filtered.length === 0 && (
                    <span className="text-[11px] text-[#666666] font-medium italic select-none">
                        Add a {noun}
                    </span>
                )}

                {canEdit && (
                <div className="relative tag-dropdown-container">
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            setShowTagDropdown(!showTagDropdown);
                        }}
                        className="flex items-center justify-center w-6 h-6 bg-[#222222] border border-[#383838] rounded-md text-[10px] text-[#888888] hover:text-white hover:border-[#555555] transition-all cursor-pointer"
                    >
                        <Plus className="w-3 h-3" />
                    </button>

                    {showTagDropdown && (
                        <div className="absolute bottom-full left-0 mb-2 bg-[#1a1a1a] border border-[#383838] rounded-lg max-h-[min(60vh,520px)] overflow-hidden flex flex-col z-50 w-[240px]">
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
                                        {others.map(termButton)}
                                    </>
                                )}
                            </div>
                        </div>
                    )}
                </div>
                )}
            </div>
    );
}
