import { X, Trash2, Save, Sparkles, ArrowLeft, RotateCcw, Copy, Check, ExternalLink, Tags, Plus } from 'lucide-react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { checkVideoExists, summarizeTranscript, getSummary, saveSummary, getSetting, openExternalUrl, getCustomPrompt, setCustomPrompt, getOllamaPrompt, getVenicePrompt, getGlossaryTerms } from '../api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TermDefinitionModal } from './TermDefinitionModal';

interface GlossaryTerm {
    term: string;
    definition: string;
}

interface Props {
    isOpen: boolean;
    onClose: () => void;
    transcript: string;
    loading: boolean;
    title: string;
    videoId?: string;
    handle?: string;
    onSave?: (summary?: string | null) => void;
    onDelete?: () => void;
    onRefetch?: () => void;
    hasApiKey: boolean;
    pluginSummarizeEnabled: boolean;
    onSummaryGenerated?: () => void;
    cachedSummaries?: Record<string, string>;
    onCacheSummary?: (videoId: string, summary: string) => void;
    allowDeletion?: boolean;
    isLibrary?: boolean;
    videoTags?: string[];
    onTagClick?: (term: GlossaryTerm) => void;
    onAddTag?: (term: string) => void;
    onRemoveTag?: (term: string) => void;
    onSearchInLibrary?: (term: string, mode: 'title' | 'transcript' | 'tag') => void;
}

export function Sidebar({ isOpen, onClose, transcript, loading, title, videoId, handle, onSave, onDelete, onRefetch, hasApiKey, pluginSummarizeEnabled, onSummaryGenerated, cachedSummaries, onCacheSummary, allowDeletion = true, isLibrary = false, videoTags = [], onTagClick, onAddTag, onRemoveTag, onSearchInLibrary }: Props) {
    const [copied, setCopied] = useState(false);
    const [summaryCopied, setSummaryCopied] = useState(false);
    const [existsInDb, setExistsInDb] = useState(false);
    const [checkingDb, setCheckingDb] = useState(false);
    const [splitPercent, setSplitPercent] = useState(65);
    const [isResizing, setIsResizing] = useState(false);
    const isResizingRef = useRef(false);
    const [showSummary, setShowSummary] = useState(false);
    const [summary, setSummary] = useState<string | null>(null);
    const [loadingSummary, setLoadingSummary] = useState(false);
    const [summaryError, setSummaryError] = useState<string | null>(null);
    const [hasExistingSummary, setHasExistingSummary] = useState(false);
    const [checkingSummary, setCheckingSummary] = useState(false);
    const [summarizeProvider, setSummarizeProvider] = useState<'local' | 'cloud'>('local');
    const [localPromptText, setLocalPromptText] = useState<string>('');
    const [cloudPromptText, setCloudPromptText] = useState<string>('');
    const [defaultLocalPrompt, setDefaultLocalPrompt] = useState<string>('');
    const [defaultCloudPrompt, setDefaultCloudPrompt] = useState<string>('');
    const [showPromptEditor, setShowPromptEditor] = useState(false);
    const [showCustomPrompt, setShowCustomPrompt] = useState(true);
    const [hasCustomPrompt, setHasCustomPrompt] = useState(false);
    const [glossaryTerms, setGlossaryTerms] = useState<GlossaryTerm[]>([]);
    const [showTagDropdown, setShowTagDropdown] = useState(false);
    const [tagFilter, setTagFilter] = useState("");
    const [selectedTerm, setSelectedTerm] = useState<GlossaryTerm | null>(null);

    const startResizing = useCallback((e: React.MouseEvent) => {
        isResizingRef.current = true;
        setIsResizing(true);
        e.preventDefault();
    }, []);

    const stopResizing = useCallback(() => {
        isResizingRef.current = false;
        setIsResizing(false);
    }, []);

    const resize = useCallback((e: MouseEvent) => {
        if (!isResizingRef.current) return;

        const sidebar = document.getElementById('sidebar-container');
        if (!sidebar) return;

        const rect = sidebar.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const newPercent = (offsetX / rect.width) * 100;

        if (newPercent > 30 && newPercent < 85) {
            setSplitPercent(newPercent);
        }
    }, []);

    useEffect(() => {
        if (isResizing) {
            document.addEventListener('mousemove', resize);
            document.addEventListener('mouseup', stopResizing);
        }
        return () => {
            document.removeEventListener('mousemove', resize);
            document.removeEventListener('mouseup', stopResizing);
        };
    }, [isResizing, resize, stopResizing]);

    useEffect(() => {
        if (isOpen) {
            getSetting('summarize_provider').then(p => {
                if (p === 'cloud') setSummarizeProvider('cloud');
                else setSummarizeProvider('local');
            });
            document.body.style.overflow = 'hidden';

            getGlossaryTerms().then(terms => {
                setGlossaryTerms(terms.map(t => ({ term: t[0], definition: t[1] })));
            }).catch(console.error);
        } else {
            document.body.style.overflow = 'auto';
        }
        return () => {
            document.body.style.overflow = 'auto';
        };
    }, [isOpen]);

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

    useEffect(() => {
        if (!isOpen) {
            setSummary(null);
            setShowSummary(false);
            setSummaryError(null);
            setHasExistingSummary(false);
            return;
        }

        if (videoId) {
            setCheckingDb(true);
            checkVideoExists(videoId).then(exists => {
                setExistsInDb(exists);
                setCheckingDb(false);
            });

            if (cachedSummaries && cachedSummaries[videoId]) {
                setSummary(cachedSummaries[videoId]);
                setShowSummary(true);
                setHasExistingSummary(true);
                setCheckingSummary(false);
            } else {
                setSummary(null);
                setShowSummary(false);
                setHasExistingSummary(false);

                setCheckingSummary(true);
                getSummary(videoId).then(existingSummary => {
                    if (existingSummary && existingSummary.trim()) {
                        setHasExistingSummary(true);
                        setSummary(existingSummary);
                        if (onCacheSummary) onCacheSummary(videoId, existingSummary);
                    } else {
                        setHasExistingSummary(false);
                    }
                    setCheckingSummary(false);
                }).catch(() => {
                    setHasExistingSummary(false);
                    setCheckingSummary(false);
                });
            }
        }
    }, [videoId, isOpen, pluginSummarizeEnabled, cachedSummaries]);

    useEffect(() => {
        if (isOpen) {
            setShowPromptEditor(false);
            getOllamaPrompt().then(p => setDefaultLocalPrompt(p)).catch(() => setDefaultLocalPrompt(''));
            getVenicePrompt().then(p => setDefaultCloudPrompt(p)).catch(() => setDefaultCloudPrompt(''));
            getSetting('showCustomPrompt').then(v => setShowCustomPrompt(v !== 'false')).catch(() => setShowCustomPrompt(true));
        }
    }, [isOpen]);

    useEffect(() => {
        if (handle) {
            getCustomPrompt(handle).then(([localPrompt, cloudPrompt]) => {
                setLocalPromptText(localPrompt || '');
                setCloudPromptText(cloudPrompt || '');
                setHasCustomPrompt(!!(localPrompt || cloudPrompt));
            }).catch(() => {
                setLocalPromptText('');
                setCloudPromptText('');
                setHasCustomPrompt(false);
            });
        } else {
            setLocalPromptText('');
            setCloudPromptText('');
            setHasCustomPrompt(false);
        }
    }, [handle, isLibrary]);

    const handleOnSave = useCallback(async () => {
        if (!videoId || !onSave) return;
        try {
            await onSave(summary);
            setExistsInDb(true);
        } catch (e) {
            console.error('Save failed:', e);
        }
    }, [videoId, onSave, summary]);

    const handleCopy = useCallback(() => {
        if (!transcript) return;
        navigator.clipboard.writeText(transcript);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, [transcript]);

    const handleCopySummary = useCallback(() => {
        if (!summary) return;
        navigator.clipboard.writeText(summary);
        setSummaryCopied(true);
        setTimeout(() => setSummaryCopied(false), 2000);
    }, [summary]);

    const handleSummarize = useCallback(async () => {
        if (!transcript || showSummary) return;

        if (hasExistingSummary && summary) {
            setShowSummary(true);
            return;
        }

        setLoadingSummary(true);
        setSummaryError(null);
        try {
            const result = await summarizeTranscript(transcript, handle);
            setSummary(result);
            setShowSummary(true);
            setHasExistingSummary(true);
            onSummaryGenerated?.();
            if (videoId && onCacheSummary) onCacheSummary(videoId, result);

            if (videoId && existsInDb) {
                try {
                    await saveSummary(videoId, result);
                } catch (e) {
                    console.error('Failed to save summary to DB:', e);
                }
            }
        } catch (err) {
            setSummaryError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoadingSummary(false);
        }
    }, [transcript, showSummary, hasExistingSummary, summary, videoId, existsInDb, onSummaryGenerated, onCacheSummary, handle]);

    const handleBackToTranscript = useCallback(() => {
        setShowSummary(false);
    }, []);

    const isTranscriptInvalid = !transcript ||
        transcript.includes("No transcript available") ||
        transcript.includes("Failed to load") ||
        transcript.includes("Could not load");

    return (
        <>
            {isOpen && (
                <div
                    className="fixed inset-0 bg-black/70 z-40 transition-opacity"
                    onClick={onClose}
                />
            )}

            <div
                id="sidebar-container"
                className={`fixed inset-y-0 right-0 w-[1100px] max-w-full bg-[#0f0f0f] border-l border-[#303030] transform transition-transform duration-300 ease-in-out z-50 ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
            >
                <div className="h-full flex flex-col">
                    <div className="p-6 border-b border-[#303030] flex justify-between items-start bg-white/5">
                        <div className="flex flex-col gap-1.5 overflow-hidden">
                            <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#aaaaaa]">Player & Transcript</span>
                            <h2 className="text-sm font-semibold text-white pr-8 line-clamp-1 leading-relaxed">
                                {title || "Untitled"}
                            </h2>
                        </div>
                        <button onClick={onClose} className="text-[#aaaaaa] hover:text-white transition-colors cursor-pointer p-1 flex-shrink-0">
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    <div className="flex-1 flex overflow-hidden relative">
                        {/* Video Player Side */}
                        <div
                            style={{ width: `${splitPercent}%` }}
                            className="p-6 border-r border-gray-900 bg-black/20 flex flex-col justify-center"
                        >
                            {videoId && isOpen ? (
                                <>
                                    <div className={`aspect-video w-full bg-black rounded-lg overflow-hidden border border-gray-800 relative group ${isResizing ? 'pointer-events-none' : ''}`}>
                                        <iframe
                                            width="100%"
                                            height="100%"
                                            src={`https://www.youtube.com/embed/${videoId}?rel=0&modestbranding=1&playsinline=1`}
                                            title="YouTube video player"
                                            frameBorder="0"
                                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                                            referrerPolicy="strict-origin-when-cross-origin"
                                            allowFullScreen
                                        />
                                        <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <button
                                                onClick={() => openExternalUrl(`https://www.youtube.com/watch?v=${videoId}`)}
                                                className="bg-black/80 hover:bg-black text-white px-3 py-1.5 rounded-md text-[10px] font-bold flex items-center gap-1.5 border border-white/10 cursor-pointer"
                                            >
                                                <ExternalLink className="w-3 h-3" />
                                                Open in YouTube
                                            </button>
                                        </div>
                                    </div>

                                    {existsInDb && (
                                        <div className="mt-6 p-4 bg-white/5 rounded-xl border border-white/5">
                                            <div className="flex items-center gap-2 mb-3">
                                                <Tags className="w-4 h-4 text-[#888888]" />
                                                <span className="text-[10px] font-bold uppercase tracking-wider text-[#888888]">Video Tags</span>
                                            </div>
                                            <div className="flex flex-wrap items-center gap-1.5">
                                                {(() => {
                                                    const filtered = [...videoTags].filter(tag => glossaryTerms.some(t => t.term === tag)).sort((a, b) => a.localeCompare(b));
                                                    return (
                                                        <>
                                                            {filtered.map((tag) => (
                                                                <button
                                                                    key={tag}
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        const term = glossaryTerms.find(t => t.term === tag);
                                                                        if (term) {
                                                                            setSelectedTerm(term);
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
                                                        </>
                                                    );
                                                })()}
                                                
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
                                                                {glossaryTerms
                                                                    .filter(t => 
                                                                        !videoTags.includes(t.term) && 
                                                                        t.term.toLowerCase().includes(tagFilter.toLowerCase())
                                                                    )
                                                                    .length === 0 ? (
                                                                    <p className="p-4 text-[11px] text-[#666666] text-center italic">
                                                                        {tagFilter ? "No matching terms" : "No terms available"}
                                                                    </p>
                                                                ) : (
                                                                    glossaryTerms
                                                                        .filter(t => 
                                                                            !videoTags.includes(t.term) && 
                                                                            t.term.toLowerCase().includes(tagFilter.toLowerCase())
                                                                        )
                                                                        .map((term) => (
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
                                    )}
                                </>
                            ) : (
                                <div className="aspect-video w-full bg-gray-900/50 rounded-lg flex items-center justify-center text-gray-700 text-[10px] uppercase tracking-widest font-bold">
                                    No Video ID
                                </div>
                            )}
                        </div>

                        {/* Draggable Divider */}
                        <div
                            onMouseDown={startResizing}
                            className={`absolute inset-y-0 w-1.5 cursor-col-resize z-10 transition-colors group ${isResizing ? 'bg-[#3f3f3f]' : 'hover:bg-[#272727]'}`}
                            style={{ left: `calc(${splitPercent}% - 3px)` }}
                        >
                            <div className="h-full w-px bg-[#303030] mx-auto" />
                        </div>

                        {/* Transcript Side */}
                        <div
                            style={{ width: `${100 - splitPercent}%` }}
                            className="overflow-y-auto p-8 text-[#aaaaaa] text-sm leading-relaxed font-sans selection:bg-[#3f3f3f] bg-[#121212]"
                        >
                            {showCustomPrompt && pluginSummarizeEnabled && (
                                <div className="mb-4 border-b border-[#333333] pb-4">
                                    <div className="flex items-center gap-2 mb-2">
                                        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#888888]">Custom Prompt</span>
                                        {(isLibrary || hasCustomPrompt) ? (
                                            <button
                                                onClick={() => setShowPromptEditor(!showPromptEditor)}
                                                className="text-[#666666] hover:text-white transition-colors cursor-pointer text-xs"
                                            >
                                                {showPromptEditor ? 'Hide Editor' : 'Show Editor'}
                                            </button>
                                        ) : (
                                            <span className="text-[10px] text-[#666666]">(Save to Library to Edit)</span>
                                        )}
                                    </div>
                                    {showPromptEditor && (
                                        <div className="mt-3 space-y-3">
                                            <div>
                                                <label className="text-[10px] uppercase tracking-wider text-[#666666] font-bold">Local (Ollama)</label>
                                                <textarea
                                                    value={localPromptText}
                                                    onChange={(e) => setLocalPromptText(e.target.value)}
                                                    placeholder={defaultLocalPrompt || "Enter custom prompt for local model..."}
                                                    className="w-full mt-1 p-2 bg-[#1a1a1a] border border-[#333333] rounded-md text-xs text-gray-300 placeholder-[#555555] focus:outline-none focus:border-[#555555] resize-none"
                                                    rows={3}
                                                />
                                            </div>
                                            <div>
                                                <label className="text-[10px] uppercase tracking-wider text-[#666666] font-bold">Cloud (Venice)</label>
                                                <textarea
                                                    value={cloudPromptText}
                                                    onChange={(e) => setCloudPromptText(e.target.value)}
                                                    placeholder={defaultCloudPrompt || "Enter custom prompt for cloud model..."}
                                                    className="w-full mt-1 p-2 bg-[#1a1a1a] border border-[#333333] rounded-md text-xs text-gray-300 placeholder-[#555555] focus:outline-none focus:border-[#555555] resize-none"
                                                    rows={3}
                                                />
                                            </div>
                                            <button
                                                onClick={async () => {
                                                    if (handle) {
                                                        await setCustomPrompt(handle, localPromptText || null, cloudPromptText || null);
                                                        setShowPromptEditor(false);
                                                    }
                                                }}
                                                disabled={!handle}
                                                className="px-3 py-1 bg-blue-600 text-white rounded-md text-[10px] font-bold hover:bg-blue-500 transition-colors disabled:opacity-30 disabled:cursor-default cursor-pointer"
                                            >
                                                Save Prompt
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Header with Summarize button */}
                            <div className="flex justify-between items-center mb-4">
                                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#aaaaaa]">
                                    {showSummary ? (
                                        <>
                                            <Sparkles className="w-3 h-3 inline" /> AI Summary
                                        </>
                                    ) : (
                                        "Transcript"
                                    )}
                                </span>
                                {showSummary ? (
                                    <button
                                        onClick={handleBackToTranscript}
                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-[#272727] text-[#aaaaaa] rounded-lg hover:text-white hover:bg-[#3f3f3f] transition-colors text-[10px] font-bold uppercase tracking-wider cursor-pointer"
                                    >
                                        <ArrowLeft className="w-3 h-3" />
                                        Back to Transcript
                                    </button>
                                ) : (
                                    (pluginSummarizeEnabled || hasExistingSummary) && (
                                        <button
                                            onClick={handleSummarize}
                                            disabled={loadingSummary || loading || !transcript || transcript.includes("No transcript") || transcript.includes("Failed to load") || checkingSummary}
                                            title={hasExistingSummary ? "View AI Summary from database" : `Generate AI summary with ${summarizeProvider === 'cloud' ? 'Venice' : 'Ollama'}`}
                                            className="summarize-btn flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-lg hover:from-purple-500 hover:to-blue-500 transition-all text-[10px] font-bold uppercase tracking-wider disabled:opacity-30 disabled:cursor-default cursor-pointer"
                                        >
                                            {checkingSummary ? (
                                                <>
                                                    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                                                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.2" />
                                                        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                                    </svg>
                                                    Checking...
                                                </>
                                            ) : loadingSummary ? (
                                                <>
                                                    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                                                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.2" />
                                                        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                                    </svg>
                                                    Generating...
                                                </>
                                            ) : (
                                                <>
                                                    <Sparkles className="w-3 h-3" />
                                                    {hasExistingSummary ? "AI Summary" : "Summarize"}
                                                </>
                                            )}
                                        </button>
                                    )
                                )}
                            </div>

                            {/* Error message */}
                            {summaryError && (
                                <div className="mb-4 p-3 bg-red-900/20 border border-red-500/30 rounded-lg text-red-400 text-xs">
                                    {summaryError}
                                </div>
                            )}

                            {/* Content */}
                            {showSummary && summary ? (
                                <div className="flex flex-col gap-3">
                                    <button
                                        onClick={handleCopySummary}
                                        className="self-start flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-red-600 hover:text-red-300 transition-colors cursor-pointer"
                                        title="Copy AI Summary to clipboard"
                                    >
                                        {summaryCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                        {summaryCopied ? "Copied" : "Copy Summary"}
                                    </button>
                                    <div className="leading-relaxed prose dark:prose-invert prose-sm max-w-none">
                                        <ReactMarkdown
                                            remarkPlugins={[remarkGfm]}
                                            components={{
                                                a: ({ node, ...props }) => (
                                                    <a
                                                        {...props}
                                                        href="#"
                                                        onClick={(e) => {
                                                            e.preventDefault();
                                                            if (props.href) openExternalUrl(props.href);
                                                        }}
                                                        className="text-red-500 hover:text-red-400 underline decoration-red-500/30 underline-offset-4"
                                                    />
                                                ),
                                                img: ({ node, ...props }) => (
                                                    <img
                                                        {...props}
                                                        className="rounded-xl border border-white/10"
                                                    />
                                                )
                                            }}
                                        >
                                            {summary}
                                        </ReactMarkdown>
                                    </div>
                                </div>
                            ) : loading ? (
                                <div className="flex flex-col justify-start items-center h-40 pt-10 text-gray-600">
                                    <svg className="w-8 h-8 animate-spin" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <circle cx="12" cy="3" r="1.5" fill="currentColor" opacity="0.1" />
                                        <circle cx="18.36" cy="5.64" r="1.5" fill="currentColor" opacity="0.2" />
                                        <circle cx="21" cy="12" r="1.5" fill="currentColor" opacity="0.3" />
                                        <circle cx="18.36" cy="18.36" r="1.5" fill="currentColor" opacity="0.4" />
                                        <circle cx="12" cy="21" r="1.5" fill="currentColor" opacity="0.6" />
                                        <circle cx="5.64" cy="18.36" r="1.5" fill="currentColor" opacity="0.8" />
                                        <circle cx="3" cy="12" r="1.5" fill="currentColor" opacity="1" />
                                        <circle cx="5.64" cy="5.64" r="1.5" fill="currentColor" opacity="0.1" />
                                    </svg>
                                    <p className="text-[10px] uppercase tracking-[0.2em] font-bold mt-4">Analysing segments</p>
                                </div>
                            ) : !isTranscriptInvalid ? (
                                <div className="text-gray-300 leading-relaxed whitespace-pre-wrap">
                                    {transcript}
                                </div>
                            ) : (
                                <div className="text-center text-gray-600 mt-10 flex flex-col items-center gap-4">
                                    <p className="text-xs uppercase tracking-widest font-bold">{transcript || "No transcript data available."}</p>
                                    {onRefetch && (
                                        <button
                                            onClick={onRefetch}
                                            title="Try Again"
                                            className="p-3 bg-gray-800/40 text-gray-400 rounded-full border border-gray-700/50 hover:bg-gray-700/60 hover:text-white transition-all cursor-pointer mt-2 group"
                                        >
                                            <RotateCcw className="w-5 h-5 group-hover:rotate-[-45deg] transition-transform duration-300" />
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="px-8 py-6 border-t border-[#303030] flex gap-4 bg-[#141414]">
                        <button
                            onClick={handleCopy}
                            disabled={loading || isTranscriptInvalid}
                            className={`flex-1 py-2 rounded-lg border border-[#383838] bg-[#222222] text-white transition-all text-sm font-semibold disabled:opacity-20 ${loading || isTranscriptInvalid ? 'cursor-default' : 'hover:bg-[#3f3f3f] cursor-pointer'}`}
                        >
                            {copied ? "Copied" : "Copy Transcript"}
                        </button>

                        {existsInDb && onDelete && allowDeletion ? (
                            <button
                                onClick={onDelete}
                                disabled={loading || isTranscriptInvalid || checkingDb || !hasApiKey}
                                title={!hasApiKey ? "API not imported" : isTranscriptInvalid ? "No transcript to delete" : "Delete from Library"}
                                className={`flex-1 py-2 rounded-lg bg-red-600 text-white transition-all text-sm font-bold disabled:opacity-20 flex items-center justify-center gap-2 ${loading || isTranscriptInvalid || checkingDb || !hasApiKey ? 'cursor-default' : 'hover:bg-red-500 cursor-pointer'}`}
                            >
                                <Trash2 className="w-4 h-4" />
                                Delete from Library
                            </button>
                        ) : !existsInDb ? (
                            <button
                                onClick={handleOnSave}
                                disabled={loading || isTranscriptInvalid || checkingDb || !hasApiKey}
                                title={!hasApiKey ? "API not imported" : isTranscriptInvalid ? "No transcript to save" : "Save to Library"}
                                className={`flex-1 py-2 rounded-lg bg-red-600 text-white transition-all text-sm font-bold disabled:opacity-20 flex items-center justify-center gap-2 ${loading || isTranscriptInvalid || checkingDb || !hasApiKey ? 'cursor-default' : 'hover:bg-red-500 cursor-pointer'}`}
                            >
                                <Save className="w-4 h-4" />
                                Save to Library
                            </button>
                        ) : null}
                    </div>
                </div>
            </div>

            {/* Term Definition Modal */}
            {selectedTerm && onSearchInLibrary && (
                <TermDefinitionModal
                    term={selectedTerm}
                    onClose={() => setSelectedTerm(null)}
                    onSearch={onSearchInLibrary}
                />
            )}
        </>
    );
}