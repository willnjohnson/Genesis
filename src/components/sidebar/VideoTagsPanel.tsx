import { useState, useEffect, useCallback } from 'react';
import { Plus, X } from 'lucide-react';

interface GlossaryTerm {
    term: string;
    definition: string;
}

interface Props {
    /** 'terms' = glossary entries with a definition; 'tags' = Quick Tags (no definition). */
    kind: 'terms' | 'tags';
    videoTags: string[];
    glossaryTerms: GlossaryTerm[];
    onAddTag?: (term: string) => void;
    onRemoveTag?: (term: string) => void;
    onSelectTerm: (term: GlossaryTerm) => void;
    /** False = read-only: tags are shown and open their definition, but can't be added or removed
     *  (a DB owner's allowEditTags flag). */
    canEdit?: boolean;
}

/** Displays a video's terms or tags (as chips, per `kind`) plus an "add" dropdown filtered to
 *  the ones not already applied. Clicking a chip opens its term definition (via
 *  `onSelectTerm`); the dropdown closes on an outside click. Renders just the tag row — the
 *  surrounding card/header is owned by Sidebar.tsx's Tags/Similar Videos tab switcher. */
export function VideoTagsPanel({ kind, videoTags, glossaryTerms, onAddTag, onRemoveTag, onSelectTerm, canEdit = true }: Props) {
    const noun = kind === 'terms' ? 'term' : 'tag';
    // A Quick Tag is a glossary entry without a definition; a term has one.
    const ofKind = glossaryTerms.filter(t => (t.definition.trim() !== '') === (kind === 'terms'));
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

    const filtered = [...videoTags].filter(tag => ofKind.some(t => t.term === tag)).sort((a, b) => a.localeCompare(b));
    const availableTerms = ofKind.filter(t =>
        !videoTags.includes(t.term) &&
        t.term.toLowerCase().includes(tagFilter.toLowerCase())
    );

    return (
            <div className="flex flex-wrap items-center gap-1.5">
                {filtered.map((tag) => (
                    <button
                        key={tag}
                        onClick={(e) => {
                            e.stopPropagation();
                            const term = ofKind.find(t => t.term === tag);
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
                        <div className="absolute bottom-full left-0 mb-2 bg-[#1a1a1a] border border-[#383838] rounded-lg max-h-[300px] overflow-hidden flex flex-col z-50 w-[240px]">
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
                            <div className="overflow-y-auto max-h-[150px] custom-scrollbar p-1">
                                {availableTerms.length === 0 ? (
                                    <p className="p-4 text-[11px] text-[#666666] text-center italic">
                                        {tagFilter ? `No matching ${noun}s` : `No ${noun}s available`}
                                    </p>
                                ) : (
                                    availableTerms.map((term) => (
                                        <button
                                            key={term.term}
                                            onClick={() => {
                                                onAddTag?.(term.term);
                                                setShowTagDropdown(false);
                                                setTagFilter("");
                                            }}
                                            className="w-full text-left px-4 py-2 text-[11px] text-white hover:bg-[#2a2a2a] transition-colors cursor-pointer rounded"
                                        >
                                            {term.term}
                                        </button>
                                    ))
                                )}
                            </div>
                        </div>
                    )}
                </div>
                )}
            </div>
    );
}
