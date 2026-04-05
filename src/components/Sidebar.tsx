import { X, Trash2, Save, Sparkles, ArrowLeft, RotateCcw, Copy, Check, ExternalLink } from 'lucide-react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { checkVideoExists, summarizeTranscript, getSummary, saveSummary, getSetting, openExternalUrl } from '../api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    transcript: string;
    loading: boolean;
    title: string;
    videoId?: string;
    onSave?: (summary?: string | null) => void;
    onDelete?: () => void;
    onRefetch?: () => void;
    hasApiKey: boolean;
    pluginSummarizeEnabled: boolean;
    onSummaryGenerated?: () => void;
    cachedSummaries?: Record<string, string>;
    onCacheSummary?: (videoId: string, summary: string) => void;
}

export function Sidebar({ isOpen, onClose, transcript, loading, title, videoId, onSave, onDelete, onRefetch, hasApiKey, pluginSummarizeEnabled, onSummaryGenerated, cachedSummaries, onCacheSummary }: Props) {
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
        } else {
            document.body.style.overflow = 'auto';
        }
        return () => {
            document.body.style.overflow = 'auto';
        };
    }, [isOpen]);

    useEffect(() => {
        // Reset summary state when video changes or sidebar is closed
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

            // check runtime cache first
            if (cachedSummaries && cachedSummaries[videoId]) {
                setSummary(cachedSummaries[videoId]);
                setShowSummary(true);
                setHasExistingSummary(true);
                setCheckingSummary(false);
            } else {
                // Reset states ONLY if not in cache
                setSummary(null);
                setShowSummary(false);
                setHasExistingSummary(false);

                // Check if summary already exists in DB
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

        // If summary already exists, just show it
        if (hasExistingSummary && summary) {
            setShowSummary(true);
            return;
        }

        setLoadingSummary(true);
        setSummaryError(null);
        try {
            const result = await summarizeTranscript(transcript);
            setSummary(result);
            setShowSummary(true);
            setHasExistingSummary(true);
            onSummaryGenerated?.();
            if (videoId && onCacheSummary) onCacheSummary(videoId, result);

            // Save summary to DB if video already exists in DB
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
    }, [transcript, showSummary, hasExistingSummary, summary, videoId, existsInDb, onSummaryGenerated, onCacheSummary]);

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
                className={`fixed inset-y-0 right-0 w-[1100px] max-w-full bg-[#0f0f0f] border-l border-[#303030] transform transition-transform duration-300 ease-in-out z-50 shadow-2xl ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
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
                                <div className={`aspect-video w-full bg-black rounded-lg overflow-hidden shadow-2xl border border-gray-800 ${isResizing ? 'pointer-events-none' : ''}`}>
                                    <iframe
                                        width="100%"
                                        height="100%"
                                        src={`https://www.youtube.com/embed/${videoId}?rel=0&modestbranding=1&playsinline=1`}
                                        title="YouTube video player"
                                        frameBorder="0"
                                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                                        referrerPolicy="strict-origin-when-cross-origin"
                                        allowFullScreen
                                    ></iframe>
                                    <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button
                                            onClick={() => openExternalUrl(`https://www.youtube.com/watch?v=${videoId}`)}
                                            className="bg-black/80 hover:bg-black text-white px-3 py-1.5 rounded-md text-[10px] font-bold flex items-center gap-1.5 shadow-xl border border-white/10 cursor-pointer backdrop-blur-sm"
                                        >
                                            <ExternalLink className="w-3 h-3" />
                                            Open in YouTube
                                        </button>
                                    </div>
                                </div>
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
                            {/* Header with Sparkle button */}
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
                                            className="summarize-btn flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-lg hover:from-purple-500 hover:to-blue-500 transition-all text-[10px] font-bold uppercase tracking-wider disabled:opacity-30 disabled:cursor-default cursor-pointer shadow-lg shadow-purple-900/20"
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
                                    <div className="text-gray-300 leading-relaxed prose prose-invert prose-sm max-w-none">
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

                        {existsInDb && onDelete ? (
                            <button
                                onClick={onDelete}
                                disabled={loading || isTranscriptInvalid || checkingDb || !hasApiKey}
                                title={!hasApiKey ? "API not imported" : isTranscriptInvalid ? "No transcript to delete" : "Delete from Library"}
                                className={`flex-1 py-2 rounded-lg bg-red-600 text-white transition-all text-sm font-bold disabled:opacity-20 shadow-lg shadow-red-900/10 flex items-center justify-center gap-2 ${loading || isTranscriptInvalid || checkingDb || !hasApiKey ? 'cursor-default' : 'hover:bg-red-500 cursor-pointer'}`}
                            >
                                <Trash2 className="w-4 h-4" />
                                Delete from Library
                            </button>
                        ) : (
                            <button
                                onClick={handleOnSave}
                                disabled={loading || isTranscriptInvalid || checkingDb || !hasApiKey}
                                title={!hasApiKey ? "API not imported" : isTranscriptInvalid ? "No transcript to save" : "Save to Library"}
                                className={`flex-1 py-2 rounded-lg bg-red-600 text-white transition-all text-sm font-bold disabled:opacity-20 shadow-lg shadow-red-900/10 flex items-center justify-center gap-2 ${loading || isTranscriptInvalid || checkingDb || !hasApiKey ? 'cursor-default' : 'hover:bg-red-500 cursor-pointer'}`}
                            >
                                <Save className="w-4 h-4" />
                                Save to Library
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </>
    );
}
