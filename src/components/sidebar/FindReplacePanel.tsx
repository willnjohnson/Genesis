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
    searchIndices: { start: number, end: number }[];
    currentSearchIndex: number;
    onClose: () => void;
    navigateMatch: (dir: 'next' | 'prev', preventFocus?: boolean) => void;
    handleReplace: () => void;
    handleReplaceAll: () => void;
}

/** Floating find/replace panel for the transcript/summary markdown editors (see useFindReplace). */
export function FindReplacePanel({
    findText, setFindText,
    replaceText, setReplaceText,
    matchCase, setMatchCase,
    matchWholeWord, setMatchWholeWord,
    searchIndices, currentSearchIndex,
    onClose, navigateMatch, handleReplace, handleReplaceAll,
}: Props) {
    return (
        <div className="absolute top-4 right-4 z-51 p-2.5 bg-[#1a1a1a] rounded-xl border border-[#303030] flex flex-col gap-2 animate-in fade-in slide-in-from-top-2 duration-200 w-80 shadow-xl">
            {/* Row 1: Find + Nav */}
            <div className="flex items-center gap-2">
                <div className="flex-1 relative group">
                    <input
                        type="text"
                        placeholder="Find text..."
                        value={findText}
                        onChange={(e) => setFindText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                navigateMatch('next', true);
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
                        disabled={searchIndices.length === 0}
                    >
                        <ChevronUp className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => navigateMatch('next')}
                        className="p-1 text-[#888888] hover:text-white transition-colors disabled:opacity-10 cursor-pointer"
                        disabled={searchIndices.length === 0}
                    >
                        <ChevronDown className="w-4 h-4" />
                    </button>
                </div>
                <button
                    onClick={onClose}
                    className="w-8 h-8 flex items-center justify-center text-[#888888] hover:text-white transition-colors cursor-pointer"
                    title="Close Find & Replace"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            {/* Row 2: Replace */}
            <div className="flex items-center gap-2">
                <input
                    type="text"
                    placeholder="Replace with..."
                    value={replaceText}
                    onChange={(e) => setReplaceText(e.target.value)}
                    className="w-full h-8 px-3 bg-[#121212] border border-[#303030] hover:border-[#505050] rounded-lg text-xs text-white placeholder-[#555555] focus:outline-none focus:border-blue-500/50 transition-all font-mono"
                />
            </div>

            {/* Row 3: Count + Replace All */}
            <div className="flex justify-between items-center px-1">
                <div className="text-[10px] font-bold tracking-widest uppercase">
                    {findText ? (
                        searchIndices.length > 0 ? (
                            <span className="text-blue-400">
                                {currentSearchIndex + 1} OF {searchIndices.length} MATCHES
                            </span>
                        ) : (
                            <span className="text-red-500/70">No results</span>
                        )
                    ) : null
                    }
                </div>
                <div className="flex items-center gap-1.5">
                    <button
                        onClick={handleReplace}
                        disabled={!findText || searchIndices.length === 0}
                        className="h-7 px-3 bg-white/5 hover:bg-white/10 text-white text-[9px] font-bold uppercase tracking-widest rounded-md transition-all cursor-pointer border border-white/5 active:scale-95 disabled:opacity-30"
                    >
                        Replace
                    </button>
                    <button
                        onClick={handleReplaceAll}
                        disabled={!findText || searchIndices.length === 0}
                        className="h-7 px-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 text-white text-[9px] font-bold uppercase tracking-widest rounded-md transition-all cursor-pointer active:scale-95"
                    >
                        Replace All
                    </button>
                </div>
            </div>
        </div>
    );
}
