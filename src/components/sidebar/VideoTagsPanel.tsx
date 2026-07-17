import { useState, useEffect, useCallback } from 'react';
import { Tags, Plus, X } from 'lucide-react';

interface GlossaryTerm {
    term: string;
    definition: string;
}

interface Props {
    videoTags: string[];
    glossaryTerms: GlossaryTerm[];
    onAddTag?: (term: string) => void;
    onRemoveTag?: (term: string) => void;
    onSelectTerm: (term: GlossaryTerm) => void;
}

/** Displays a video's tags (as glossary-term chips) plus an "add tag" dropdown filtered to
 *  glossary terms not already applied. Clicking a chip opens its term definition (via
 *  `onSelectTerm`); the dropdown closes on an outside click. */
export function VideoTagsPanel({ videoTags, glossaryTerms, onAddTag, onRemoveTag, onSelectTerm }: Props) {
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

    const filtered = [...videoTags].filter(tag => glossaryTerms.some(t => t.term === tag)).sort((a, b) => a.localeCompare(b));
    const availableTerms = glossaryTerms.filter(t =>
        !videoTags.includes(t.term) &&
        t.term.toLowerCase().includes(tagFilter.toLowerCase())
    );

    return (
        <div className="mt-6 p-4 bg-white/5 rounded-xl border border-white/5">
            <div className="flex items-center gap-2 mb-3">
                <Tags className="w-4 h-4 text-[#888888]" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#888888]">Video Tags</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
                {filtered.map((tag) => (
                    <button
                        key={tag}
                        onClick={(e) => {
                            e.stopPropagation();
                            const term = glossaryTerms.find(t => t.term === tag);
                            if (term) {
                                onSelectTerm(term);
                            }
                        }}
                        className="group flex items-center gap-1 px-2.5 py-1 bg-[#222222] border border-[#383838] rounded-md text-[11px] text-white hover:bg-[#333333] transition-all cursor-pointer"
                    >
                        {tag}
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onRemoveTag?.(tag);
                            }}
                            className="text-[#666666] hover:text-red-500 transition-colors ml-1"
                        >
                            <X className="w-3 h-3" />
                        </button>
                    </button>
                ))}

                {filtered.length === 0 && (
                    <span className="text-[11px] text-[#666666] font-medium italic select-none">
                        Create a new tag
                    </span>
                )}

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
                                    placeholder="Filter glossary terms..."
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
                                        {tagFilter ? "No matching terms" : "No terms available"}
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
            </div>
        </div>
    );
}
