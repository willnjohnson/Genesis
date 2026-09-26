import { X, ChevronUp, ChevronDown, CaseSensitive, WholeWord } from 'lucide-react';

interface Props {
    findText: string;
    setFindText: (value: string) => void;
    replaceText: string;
    setReplaceText: (value: string) => void;
    matchCase: boolean;
    setMatchCase: (value: boolean) => void;
    matchWholeWord: boolean;
    setMatchWholeWord: (value: boolean) => void;
    /** How many matches there are. */
    matchCount: number;
    currentSearchIndex: number;
    onClose: () => void;
    navigateMatch: (dir: 'next' | 'prev', preventFocus?: boolean) => void;
    handleReplace: () => void;
    handleReplaceAll: () => void;
    /** Just the search half (the read-only Ctrl+F): no Replace box or buttons. */
    findOnly?: boolean;
    /** Where it goes: floating at the top-'right' of its area (the default), or 'inline', a full-width row in the
     *  flow of the page, so it sits above whatever follows instead of over it. */
    anchor?: 'inline' | 'right';
}

/** Floating find/replace panel for the transcript/summary markdown editors (see useFindReplace). */
export function FindReplacePanel({
    findText, setFindText,
    replaceText, setReplaceText,
    matchCase, setMatchCase,
    matchWholeWord, setMatchWholeWord,
    matchCount, currentSearchIndex,
    onClose, navigateMatch, handleReplace, handleReplaceAll, findOnly, anchor = 'right',
}: Props) {
    return (
        <div className={`${anchor === 'inline' ? 'relative w-full shrink-0' : 'absolute top-4 right-4 max-w-[calc(100%-2rem)] pointer-events-auto z-51 w-80'} p-2.5 bg-[#1a1a1a] rounded-xl border border-[#303030] flex flex-col gap-2 animate-in fade-in slide-in-from-top-2 duration-200 shadow-xl`}>
            {/* Row 1: Find + Nav */}
            <div className="flex items-center gap-2">
                <div className="flex-1 relative group">
                    <input
                        id="sidebar-find-input"
                        autoFocus
                        type="text"
                        placeholder="Find text..."
                        value={findText}
                        onChange={(e) => setFindText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                navigateMatch(e.shiftKey ? 'prev' : 'next', true);
                            }
                        }}
                        className="w-full h-8 pl-3 pr-16 bg-[#121212] border border-[#303030] hover:border-[#505050] rounded-lg text-xs text-white placeholder-[#555555] focus:outline-none focus:border-blue-500/50 transition-all font-mono"
                    />
                    <div className="absolute right-1 top-0.5 bottom-0.5 flex items-center gap-0.5">
                        <button
                            onClick={() => setMatchCase(!matchCase)}
                            className={`p-1 rounded transition-all cursor-pointer ${matchCase ? 'bg-blue-600 text-white' : 'text-[#888888] hover:text-white hover:bg-white/10'}`}
                            title="Match Case"
                        >
                            <CaseSensitive className="w-3.5 h-3.5" />
                        </button>
                        <button
                            onClick={() => setMatchWholeWord(!matchWholeWord)}
                            className={`p-1 rounded transition-all cursor-pointer ${matchWholeWord ? 'bg-blue-600 text-white' : 'text-[#888888] hover:text-white hover:bg-white/10'}`}
                            title="Match Whole Word"
                        >
                            <WholeWord className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>
                <div className="flex items-center bg-[#121212] border border-[#303030] rounded-lg h-8 px-0.5">
                    <button
                        onClick={() => navigateMatch('prev')}
                        className="p-1 text-[#888888] hover:text-white transition-colors disabled:opacity-10 cursor-pointer"
                        disabled={matchCount === 0}
                    >
                        <ChevronUp className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => navigateMatch('next')}
                        className="p-1 text-[#888888] hover:text-white transition-colors disabled:opacity-10 cursor-pointer"
                        disabled={matchCount === 0}
                    >
                        <ChevronDown className="w-4 h-4" />
                    </button>
                </div>
                <button
                    onClick={onClose}
                    className="w-8 h-8 flex items-center justify-center text-[#888888] hover:text-white transition-colors cursor-pointer"
                    title={findOnly ? "Close Find" : "Close Find & Replace"}
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            {/* Row 2: Replace */}
            {!findOnly && <div className="flex items-center gap-2">
                <input
                    type="text"
                    placeholder="Replace with..."
                    value={replaceText}
                    onChange={(e) => setReplaceText(e.target.value)}
                    className="w-full h-8 px-3 bg-[#121212] border border-[#303030] hover:border-[#505050] rounded-lg text-xs text-white placeholder-[#555555] focus:outline-none focus:border-blue-500/50 transition-all font-mono"
                />
            </div>}

            {/* Row 3: Count + Replace All */}
            {(!findOnly || findText) && <div className="flex justify-between items-center px-1">
                <div className="text-[10px] font-bold tracking-widest uppercase">
                    {findText ? (
                        matchCount > 0 ? (
                            <span className="text-blue-400">
                                {currentSearchIndex + 1} OF {matchCount} MATCHES
                            </span>
                        ) : (
                            <span className="text-red-500/70">No results</span>
                        )
                    ) : null
                    }
                </div>
                {!findOnly && <div className="flex items-center gap-1.5">
                    <button
                        onClick={handleReplace}
                        disabled={!findText || matchCount === 0}
                        className="h-7 px-3 bg-white/5 hover:bg-white/10 text-white text-[9px] font-bold uppercase tracking-widest rounded-md transition-all cursor-pointer border border-white/5 active:scale-95 disabled:opacity-30"
                    >
                        Replace
                    </button>
                    <button
                        onClick={handleReplaceAll}
                        disabled={!findText || matchCount === 0}
                        className="h-7 px-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 text-white text-[9px] font-bold uppercase tracking-widest rounded-md transition-all cursor-pointer active:scale-95"
                    >
                        Replace All
                    </button>
                </div>}
            </div>}
        </div>
    );
}
