import { X, Trash2, Save, Sparkles, ArrowLeft, RotateCcw, Copy, Check, ExternalLink, Pencil, Search, Terminal, Lightbulb, Eye, EyeOff } from 'lucide-react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { checkVideoExists, summarizeTranscript, getSummary, saveSummary, getSetting, openExternalUrl, getCustomPrompt, setCustomPrompt, getOllamaPrompt, getVenicePrompt, getGlossaryTerms, saveTranscript, getEmbedServerPort } from '../api';
import { saveImageAs } from '../lib/save-image-as';
import { handleMarkdownKeyDown } from '../lib/markdown-editor';
import { useFindReplace } from './sidebar/useFindReplace';
import { FindReplacePanel } from './sidebar/FindReplacePanel';
import { PhotosynthesisPanel } from './sidebar/PhotosynthesisPanel';
import { VideoTagsPanel } from './sidebar/VideoTagsPanel';
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
    pluginPhotosynthesisEnabled: boolean;
    showSynthesizeVenice?: boolean;
    showSynthesizePixabay?: boolean;
    showSynthesizeUpload?: boolean;
    onSummaryGenerated?: () => void;
    cachedSummaries?: Record<string, string>;
    onCacheSummary?: (videoId: string, summary: string) => void;
    allowDeletion?: boolean;
    isLibrary?: boolean;
    videoTags?: string[];
    onHandleClick?: (handle: string) => void;
    onAddTag?: (term: string) => void;
    onRemoveTag?: (term: string) => void;
    onSearchInLibrary?: (term: string, mode: 'tag' | 'library') => void;
    initialTab?: 'transcript' | 'summary';
    showBiography?: boolean;
    allowEditTranscriptOnNA?: boolean;
}

/**
 * Slide-over panel showing a video's transcript/AI summary, with editing, find/replace, tag
 * management, and (when enabled) the Photosynthesis image-generation tools. Split across
 * `./sidebar/`: `useFindReplace`/`FindReplacePanel` own find/replace, `PhotosynthesisPanel` owns
 * the Venice/Pixabay/upload image tooling, and `VideoTagsPanel` owns the tag chips/dropdown.
 * This file remains the orchestrating shell — it owns the transcript/summary editing state
 * directly, since the two panes are asymmetric (only the summary pane supports image hover-to-
 * delete) rather than a clean shared abstraction.
 */
export function Sidebar({ isOpen, onClose, transcript, loading, title, videoId, handle, onSave, onDelete, onRefetch, hasApiKey, pluginSummarizeEnabled, pluginPhotosynthesisEnabled, showSynthesizeVenice = true, showSynthesizePixabay = true, showSynthesizeUpload = true, onSummaryGenerated, cachedSummaries, onCacheSummary, allowDeletion = true, isLibrary = false, videoTags = [], onHandleClick, onAddTag, onRemoveTag, onSearchInLibrary, initialTab, showBiography = true, allowEditTranscriptOnNA = true }: Props) {
    const [copied, setCopied] = useState(false);
    const [summaryCopied, setSummaryCopied] = useState(false);
    const [existsInDb, setExistsInDb] = useState(false);
    const [checkingDb, setCheckingDb] = useState(false);
    const [splitPercent, setSplitPercent] = useState(65);
    const [isResizing, setIsResizing] = useState(false);
    const isResizingRef = useRef(false);
    const autoSwitchedToSummaryRef = useRef(false);
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
    const [promptTab, setPromptTab] = useState<'local' | 'cloud'>('local');
    const [glossaryTerms, setGlossaryTerms] = useState<GlossaryTerm[]>([]);
    const [selectedTerm, setSelectedTerm] = useState<GlossaryTerm | null>(null);
    const [isEditingTranscript, setIsEditingTranscript] = useState(false);
    const [isEditingSummary, setIsEditingSummary] = useState(false);
    const [editedTranscript, setEditedTranscript] = useState('');
    const [editedSummary, setEditedSummary] = useState('');
    const [summaryImageHover, setSummaryImageHover] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [imageTab, setImageTab] = useState<'venice' | 'pixabay' | 'upload'>('venice');
    const [showImageUploadErrorModal, setShowImageUploadErrorModal] = useState(false);
    const [imageUploadErrorMessage, setImageUploadErrorMessage] = useState("");
    const [imageToSaveLocally, setImageToSaveLocally] = useState("");
    const [fullscreenImage, setFullscreenImage] = useState<string | null>(null);
    const [embedPort, setEmbedPort] = useState<number | null>(null);

    const transcriptEditRef = useRef<HTMLTextAreaElement>(null);
    const summaryEditRef = useRef<HTMLTextAreaElement>(null);
    const transcriptBackdropRef = useRef<HTMLDivElement>(null);
    const summaryBackdropRef = useRef<HTMLDivElement>(null);

    const {
        findText, setFindText,
        replaceText, setReplaceText,
        matchCase, setMatchCase,
        matchWholeWord, setMatchWholeWord,
        searchIndices, currentSearchIndex,
        showFindReplace, setShowFindReplace,
        navigateMatch, handleReplace, handleReplaceAll,
    } = useFindReplace({
        isEditingTranscript, editedTranscript, editedSummary,
        setEditedTranscript, setEditedSummary,
        transcriptEditRef, summaryEditRef, transcriptBackdropRef, summaryBackdropRef,
    });

    const handleDeleteSummaryImage = (src: string) => {
        if (!src) return;

        const lines = editedSummary.split('\n');
        const newLines = lines.filter((line) => !line.includes(src));
        const cleanedSummary = newLines.join('\n').replace(/\n\n\n+/g, '\n\n').trim();

        setEditedSummary(cleanedSummary);
    };

    useEffect(() => {
        getEmbedServerPort().then(setEmbedPort).catch(() => setEmbedPort(null));
    }, []);

    useEffect(() => {
        if (imageTab === 'venice' && !showSynthesizeVenice) {
            if (showSynthesizePixabay) setImageTab('pixabay');
            else if (showSynthesizeUpload) setImageTab('upload');
        } else if (imageTab === 'pixabay' && !showSynthesizePixabay) {
            if (showSynthesizeVenice) setImageTab('venice');
            else if (showSynthesizeUpload) setImageTab('upload');
        } else if (imageTab === 'upload' && !showSynthesizeUpload) {
            if (showSynthesizeVenice) setImageTab('venice');
            else if (showSynthesizePixabay) setImageTab('pixabay');
        }
    }, [imageTab, showSynthesizeVenice, showSynthesizePixabay, showSynthesizeUpload]);

    const startResizing = useCallback((e: React.MouseEvent) => {
        isResizingRef.current = true;
        setIsResizing(true);
        e.preventDefault();
    }, []);

    const stopResizing = useCallback(() => {
        isResizingRef.current = false;
        setIsResizing(false);
    }, []);

    const handleSaveImageAs = async (url: string) => {
        await saveImageAs(url, {
            filters: [{ name: 'Image', extensions: ['webp'] }],
            defaultPath: 'generated-image.webp'
        });
    };

    const handleUploadError = (message: string, imageUrl: string) => {
        setImageUploadErrorMessage(message);
        setImageToSaveLocally(imageUrl);
        setShowImageUploadErrorModal(true);
    };

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

    const handleSaveTranscript = async () => {
        if (!videoId) return;
        setIsSaving(true);
        try {
            await saveTranscript(videoId, editedTranscript);
            setIsEditingTranscript(false);
            if (onRefetch) onRefetch();
        } catch (e: any) {
            console.error("Failed to save transcript:", e);
        } finally {
            setIsSaving(false);
        }
    };

    const handleSaveEditedSummary = async () => {
        if (!videoId) return;
        setIsSaving(true);
        try {
            await saveSummary(videoId, editedSummary);
            // save_summary appends a "Channel Info:" footer server-side; re-fetch so what's
            // displayed/cached matches what's actually persisted.
            const saved = await getSummary(videoId);
            const displaySummary = saved || editedSummary;
            setSummary(displaySummary);
            if (onCacheSummary) onCacheSummary(videoId, displaySummary);
            // getSummary() filters out footer-only/empty summaries, so a null `saved` here means
            // the user wiped the summary back to empty — keep hasExistingSummary in sync (it was
            // otherwise never reset after an edit), and jump back to the Transcript tab since the
            // backend just restored the transcript from its "N/A" placeholder for this case.
            setHasExistingSummary(!!saved);
            setIsEditingSummary(false);
            if (!saved) setShowSummary(false);
            if (onRefetch) onRefetch();
        } catch (e: any) {
            console.error("Failed to save summary:", e);
        } finally {
            setIsSaving(false);
        }
    };

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

    useEffect(() => {
        if (!isOpen) {
            setSummary(null);
            setShowSummary(false);
            setSummaryError(null);
            setHasExistingSummary(false);
            setIsEditingSummary(false);
            setIsEditingTranscript(false);
            return;
        }

        setIsEditingSummary(false);
        setIsEditingTranscript(false);
        autoSwitchedToSummaryRef.current = false;

        if (initialTab) {
            setShowSummary(initialTab === 'summary');
        } else {
            setShowSummary(false);
        }

        if (videoId) {
            setCheckingDb(true);
            checkVideoExists(videoId).then(exists => {
                setExistsInDb(exists);
                setCheckingDb(false);
            });

            if (cachedSummaries && cachedSummaries[videoId]) {
                setSummary(cachedSummaries[videoId]);
                if (!initialTab) setShowSummary(true);
                setHasExistingSummary(true);
                setCheckingSummary(false);
            } else {
                setSummary(null);
                if (!initialTab) setShowSummary(false);
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
    }, [videoId, isOpen, pluginSummarizeEnabled, initialTab]); // eslint-disable-line react-hooks/exhaustive-deps

    // Keep summary text/flag in sync with the app-level cache without re-deriving which tab is
    // shown. This must NOT touch showSummary: the effect above already reads cachedSummaries
    // (via closure) whenever it runs on open/videoId changes, so re-running the tab-selection
    // logic here too would immediately hide a summary the user just generated, since caching it
    // (handleSummarize -> onCacheSummary) is exactly what changes this cachedSummaries reference.
    useEffect(() => {
        if (isOpen && videoId && cachedSummaries && cachedSummaries[videoId]) {
            setSummary(cachedSummaries[videoId]);
            setHasExistingSummary(true);
        }
    }, [cachedSummaries, videoId, isOpen]);

    // The transcript column gets overwritten with the literal placeholder "N/A" once a video has
    // been summarized (to free up DB space), so landing on the Transcript tab would just show that
    // placeholder. Auto-switch to AI Summary the first time this loads per video, but only once so
    // it doesn't fight a user who deliberately navigates back to Transcript afterwards (e.g. to
    // restore real transcript text).
    useEffect(() => {
        if (isOpen && !autoSwitchedToSummaryRef.current && transcript && transcript.trim() === "N/A") {
            autoSwitchedToSummaryRef.current = true;
            setShowSummary(true);
        }
    }, [isOpen, transcript]);

                    useEffect(() => {
        if (isOpen) {
            setShowPromptEditor(false);
            getOllamaPrompt().then(p => setDefaultLocalPrompt(p)).catch(() => setDefaultLocalPrompt(''));
            getVenicePrompt().then(p => setDefaultCloudPrompt(p)).catch(() => setDefaultCloudPrompt(''));
            getSetting('showCustomPrompt').then(v => setShowCustomPrompt(v !== 'false')).catch(() => setShowCustomPrompt(true));
        }
    }, [isOpen]);

    const [isPreviewingTranscript, setIsPreviewingTranscript] = useState(false);
    const [isPreviewingSummary, setIsPreviewingSummary] = useState(false);

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
            if (summary) {
                // Saving appends a "Channel Info:" footer to the summary server-side; re-fetch
                // so what's displayed/cached matches what's actually persisted.
                const saved = await getSummary(videoId);
                if (saved) {
                    setSummary(saved);
                    if (onCacheSummary) onCacheSummary(videoId, saved);
                }
            }
        } catch (e) {
            console.error('Save failed:', e);
        }
    }, [videoId, onSave, summary, onCacheSummary]);

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
            const result = await summarizeTranscript(transcript, handle, videoId);
            let displaySummary = result;

            if (videoId) {
                try {
                    await saveSummary(videoId, result);
                    // save_summary appends a "Channel Info:" footer server-side; re-fetch so
                    // what's displayed matches what's actually persisted, instead of showing
                    // the raw pre-footer text the summarizer returned. If the video hasn't been
                    // saved to the library yet, saveSummary's UPDATE is a harmless no-op (no row
                    // to persist to) and getSummary returns nothing, so displaySummary just stays
                    // the freshly generated result.
                    const saved = await getSummary(videoId);
                    if (saved) displaySummary = saved;
                } catch (e) {
                    console.error('Failed to save summary to DB:', e);
                }
            }

            setSummary(displaySummary);
            setShowSummary(true);
            setHasExistingSummary(true);
            onSummaryGenerated?.();
            if (videoId && onCacheSummary) onCacheSummary(videoId, displaySummary);
        } catch (err) {
            setSummaryError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoadingSummary(false);
        }
    }, [transcript, showSummary, hasExistingSummary, summary, videoId, onSummaryGenerated, onCacheSummary, handle]);

    const handleBackToTranscript = useCallback(() => {
        setShowSummary(false);
        setIsEditingSummary(false);
        setIsEditingTranscript(false);
    }, []);

    // Error sentinels are always short, app-generated strings (see App.tsx), so gate the
    // substring match on length too — otherwise a real transcript that happens to mention
    // "No transcript" in its actual spoken content would false-positive here.
    const isTranscriptInvalid = !transcript ||
        (transcript.length < 150 && (
            transcript.includes("No transcript") ||
            transcript.includes("Failed to load") ||
            transcript.includes("Could not load")
        ));

    // Transcript never loaded because no API key is set: going "back" would just show that
    // error, so hide the button when an AI summary is available instead.
    const isTranscriptMissingApiKey = !!transcript && transcript.includes("API key missing");

    // "N/A" is the placeholder left behind once a video's real transcript has been cleared in
    // favor of its AI summary (see the auto-switch effect above and clear_transcript_after_summary
    // server-side) — with allowEditTranscriptOnNA disabled, editing that placeholder is misleading
    // since the summary is the source of truth, so hide the pencil in exactly that case.
    const hideTranscriptEditButton = allowEditTranscriptOnNA === false &&
        transcript?.trim() === "N/A" && hasExistingSummary;

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
                className={`fixed inset-y-0 right-0 w-[1400px] max-w-full bg-[#0f0f0f] border-l border-[#303030] transform transition-transform duration-300 ease-in-out z-50 ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
            >
                <div className="h-full flex flex-col">
                    <div className="p-4 border-b border-[#303030] flex justify-between items-start bg-white/5">
                        <div className="flex gap-4 items-start">
                            {videoId && (
                                <img
                                    src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`}
                                    alt={title || "Untitled"}
                                    className="w-30 h-16 object-cover rounded-lg"
                                />
                            )}
                            <div className="flex flex-col gap-1 overflow-hidden">
                                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#aaaaaa]">
                                    Transcript
                                </span>
                                <h2 className="text-sm font-semibold text-white pr-8 line-clamp-2 leading-relaxed">
                                    {title || "Untitled"}
                                </h2>
                                {handle && (
                                    <button
                                        onClick={showBiography ? () => onHandleClick?.(handle.startsWith('@') ? handle : `@${handle}`) : undefined}
                                        className={`text-xs text-[#aaaaaa] ${showBiography ? 'hover:text-red-400 cursor-pointer' : ''} text-left`}
                                        title={showBiography ? "View Bio" : undefined}
                                    >
                                        {handle.startsWith('@') ? handle : `@${handle}`}
                                    </button>
                                )}
                            </div>
                        </div>
                        <button onClick={onClose} className="text-[#aaaaaa] hover:text-white transition-colors cursor-pointer p-1 flex-shrink-0">
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {/* Find & Replace Panel */}
                    {showFindReplace && (
                        <FindReplacePanel
                            findText={findText} setFindText={setFindText}
                            replaceText={replaceText} setReplaceText={setReplaceText}
                            matchCase={matchCase} setMatchCase={setMatchCase}
                            matchWholeWord={matchWholeWord} setMatchWholeWord={setMatchWholeWord}
                            searchIndices={searchIndices} currentSearchIndex={currentSearchIndex}
                            onClose={() => setShowFindReplace(false)}
                            navigateMatch={navigateMatch}
                            handleReplace={handleReplace}
                            handleReplaceAll={handleReplaceAll}
                        />
                    )}

                    <div className="flex-1 flex overflow-hidden relative">
                        {/* Left Side: Video Player or Image Tools */}
                        <div
                            style={{ width: `${splitPercent}%` }}
                            className="border-r border-gray-900 bg-black/20 flex flex-col h-full overflow-hidden"
                        >
                            {(pluginPhotosynthesisEnabled && showSummary && isEditingSummary) ? (
                                <PhotosynthesisPanel
                                    showSynthesizeVenice={showSynthesizeVenice}
                                    showSynthesizePixabay={showSynthesizePixabay}
                                    showSynthesizeUpload={showSynthesizeUpload}
                                    imageTab={imageTab}
                                    setImageTab={setImageTab}
                                    isEditingTranscript={isEditingTranscript}
                                    isEditingSummary={isEditingSummary}
                                    editedTranscript={editedTranscript}
                                    editedSummary={editedSummary}
                                    setEditedTranscript={setEditedTranscript}
                                    setEditedSummary={setEditedSummary}
                                    onUploadError={handleUploadError}
                                />
                            ) : (
                                <div className="flex-1 overflow-y-auto p-6 flex flex-col custom-scrollbar">
                                    {videoId && isOpen ? (
                                        <>
                                            <div className={`aspect-video w-full bg-black rounded-lg overflow-hidden border border-gray-800 relative group ${isResizing ? 'pointer-events-none' : ''}`}>
                                                 <iframe
                                                     width="100%"
                                                     height="100%"
                                                     src={videoId && embedPort ? `http://localhost:${embedPort}/youtube_embed?v=${videoId}` : undefined}
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
                                                <VideoTagsPanel
                                                    videoTags={videoTags}
                                                    glossaryTerms={glossaryTerms}
                                                    onAddTag={onAddTag}
                                                    onRemoveTag={onRemoveTag}
                                                    onSelectTerm={setSelectedTerm}
                                                />
                                            )}
                                        </>
                                    ) : (
                                        <div className="aspect-video w-full bg-gray-900/50 rounded-lg flex items-center justify-center text-gray-700 text-[10px] uppercase tracking-widest font-bold">
                                            No Video ID
                                        </div>
                                    )}
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
                            className="p-8 text-[#aaaaaa] text-sm leading-relaxed font-sans selection:bg-[#3f3f3f] flex flex-col overflow-hidden"
                        >
                            <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar flex flex-col">
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
                                    <div className="flex items-center gap-2">
                                        {!showPromptEditor && (
                                            <>
                                                {showSummary ? (
                                                    !isTranscriptMissingApiKey && (
                                                        <button
                                                            onClick={handleBackToTranscript}
                                                            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#272727] text-[#aaaaaa] rounded-lg hover:text-white hover:bg-[#3f3f3f] transition-colors text-[10px] font-bold uppercase tracking-wider cursor-pointer"
                                                        >
                                                            <ArrowLeft className="w-3 h-3" />
                                                            Back to Transcript
                                                        </button>
                                                    )
                                                ) : (
                                                    !isEditingTranscript && !isEditingSummary && (pluginSummarizeEnabled || hasExistingSummary) && (
                                                        <button
                                                            onClick={handleSummarize}
                                                            disabled={loadingSummary || loading || isTranscriptInvalid || checkingSummary}
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
                                                {(isEditingTranscript || isEditingSummary) && (
                                                    <button
                                                        onClick={() => setShowFindReplace(!showFindReplace)}
                                                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all text-[10px] font-bold uppercase tracking-wider cursor-pointer ${showFindReplace ? 'bg-blue-600 text-white' : 'bg-[#272727] text-[#aaaaaa] hover:text-white hover:bg-[#3f3f3f]'}`}
                                                    >
                                                        <Search className="w-3 h-3" />
                                                        {showFindReplace ? 'Close Find' : 'Find & Replace'}
                                                    </button>
                                                )}
                                                {!showSummary && !isEditingTranscript && pluginPhotosynthesisEnabled && !hideTranscriptEditButton && (
                                                    <button
                                                        onClick={() => {
                                                            setIsEditingTranscript(true);
                                                            setIsEditingSummary(false);
                                                            setEditedTranscript(transcript);
                                                        }}
                                                        className="p-1.5 bg-[#272727] text-[#aaaaaa] rounded-lg hover:text-white hover:bg-[#3f3f3f] transition-colors cursor-pointer"
                                                        title="Edit Transcript"
                                                    >
                                                        <Pencil className="w-3 h-3" />
                                                    </button>
                                                )}
                                                {showSummary && !isEditingSummary && summary && pluginPhotosynthesisEnabled && (
                                                    <button
                                                        onClick={() => {
                                                            setIsEditingSummary(true);
                                                            setIsEditingTranscript(false);
                                                            setEditedSummary(summary);
                                                        }}
                                                        className="p-1.5 bg-[#272727] text-[#aaaaaa] rounded-lg hover:text-white hover:bg-[#3f3f3f] transition-colors cursor-pointer"
                                                        title="Edit AI Summary"
                                                    >
                                                        <Pencil className="w-3 h-3" />
                                                    </button>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>

                                {/* Error message */}
                                {summaryError && (
                                    <div className="mb-4 p-3 bg-red-900/20 border border-red-500/30 rounded-lg text-red-400 text-xs">
                                        {summaryError}
                                    </div>
                                )}

                                {/* Content */}
                                <div className="flex-1 flex flex-col">
                                {showSummary && summary && !showPromptEditor ? (
                                        <div className="flex flex-col gap-3 h-full">
                                              {isEditingSummary ? (
                                                  <div className="flex flex-col flex-1 min-h-0 gap-2">
                                                      {!isPreviewingSummary ? (
                                                     <div className="relative flex-1 min-h-[500px] bg-black/20 rounded-lg border border-[#333] focus-within:border-purple-500 overflow-hidden">
                                                          <div
                                                              ref={summaryBackdropRef}
                                                              className="absolute inset-0 w-full h-full p-3 m-0 border-none font-mono text-xs leading-relaxed whitespace-pre-wrap break-words overflow-y-auto pointer-events-none"
                                                              style={{ color: 'transparent', scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                                                              aria-hidden="true"
                                                          >
                                                              {showFindReplace && searchIndices.length > 0 && currentSearchIndex !== -1 ? (
                                                                  <>
                                                                      {editedSummary.substring(0, searchIndices[currentSearchIndex].start)}
                                                                      <mark className="bg-purple-500/50 rounded-sm text-transparent" style={{ color: 'transparent' }}>
                                                                          {editedSummary.substring(searchIndices[currentSearchIndex].start, searchIndices[currentSearchIndex].end)}
                                                                      </mark>
                                                                      {editedSummary.substring(searchIndices[currentSearchIndex].end)}
                                                                  </>
                                                              ) : (
                                                                  editedSummary
                                                              )}
                                                              {editedSummary.endsWith('\n') && <br />}
                                                          </div>
                                                         <textarea
                                                             ref={summaryEditRef}
                                                             value={editedSummary}
                                                             onChange={(e) => setEditedSummary(e.target.value)}
                                                             onScroll={(e) => {
                                                                 if (summaryBackdropRef.current) {
                                                                     summaryBackdropRef.current.scrollTop = e.currentTarget.scrollTop;
                                                                     summaryBackdropRef.current.scrollLeft = e.currentTarget.scrollLeft;
                                                                 }
                                                             }}
                                                             onKeyDown={(e) => {
                                                                 handleMarkdownKeyDown(e, editedSummary, setEditedSummary);
                                                                 if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                                                                     e.preventDefault();
                                                                     setShowFindReplace(!showFindReplace);
                                                                 }
                                                             }}
                                                              className="absolute inset-0 w-full h-full p-3 m-0 border-none bg-transparent text-white outline-none text-xs leading-relaxed resize-none font-mono selection:bg-purple-500/30"
                                                             spellCheck={false}
                                                         />
                                                     </div>
                                                     ) : (
                                                     <div className="flex-1 flex flex-col">
                                                         <div className="flex-1 relative rounded-lg border border-[#333] bg-black/20 overflow-hidden">
                                                             <div className="absolute inset-0 p-3 overflow-y-auto custom-scrollbar">
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
                                                                             (() => {
                                                                                 const src = props.src || '';
                                                                                 const isHovered = summaryImageHover === src;

                                                                                 return (
                                                                                     <div
                                                                                         className="relative inline-block my-2"
                                                                                         onMouseEnter={() => setSummaryImageHover(src)}
                                                                                         onMouseLeave={() => setSummaryImageHover(null)}
                                                                                     >
                                                                                         <img
                                                                                             {...props}
                                                                                             className="rounded-xl border border-white/10 cursor-pointer"
                                                                                             onClick={() => setFullscreenImage(src)}
                                                                                         />
                                                                                         {isHovered && (
                                                                                             <button
                                                                                                 onClick={(e) => {
                                                                                                     e.stopPropagation();
                                                                                                     handleDeleteSummaryImage(src);
                                                                                                 }}
                                                                                                 className="absolute top-2 right-2 w-6 h-6 bg-red-600 rounded-full flex items-center justify-center text-white hover:bg-red-500 z-10 cursor-pointer"
                                                                                                 title="Delete image"
                                                                                             >
                                                                                                 <X className="w-4 h-4" />
                                                                                             </button>
                                                                                         )}
                                                                                     </div>
                                                                                 );
                                                                             })()
                                                                          )
                                                                     }}
                                                                 >
                                                                     {editedSummary}
                                                                 </ReactMarkdown>
                                                             </div>
                                                         </div>
                                                     </div>
                                                     )}
                                                       <div className="flex justify-between items-center p-2">
                                                           <div
                                                               onClick={() => setIsPreviewingSummary(!isPreviewingSummary)}
                                                               className="cursor-pointer p-2 rounded-lg hover:bg-[#272727] transition-colors text-[#aaaaaa] hover:text-white"
                                                               title={isPreviewingSummary ? "Back to Edit" : "Preview"}
                                                           >
                                                               {isPreviewingSummary ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                                           </div>
                                                           <div className="flex gap-2">
                                                               <button
                                                                   onClick={() => setIsEditingSummary(false)}
                                                                   className="px-3 py-1.5 text-[10px] font-bold uppercase tracking_wider text-[#aaaaaa] hover:text-white transition-colors cursor-pointer"
                                                               >
                                                                   Cancel
                                                               </button>
                                                               <button
                                                                   onClick={handleSaveEditedSummary}
                                                                   disabled={isSaving || isPreviewingSummary}
                                                                   className="px-4 py-1.5 bg-purple-600 text-white rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-purple-500 transition-colors disabled:opacity-30 cursor-pointer"
                                                               >
                                                                   {isSaving ? "Saving..." : "Save Changes"}
                                                               </button>
                                                           </div>
                                                       </div>
                                                </div>
                                            ) : (
                                                <>
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
                                                                         className="rounded-xl border border-white/10 cursor-pointer"
                                                                         onClick={() => setFullscreenImage(props.src || '')}
                                                                     />
                                                                 )
                                                            }}
                                                        >
                                                            {summary}
                                                        </ReactMarkdown>
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    ) : showPromptEditor && pluginSummarizeEnabled ? (
                                        <div className="flex-1 flex flex-col gap-4">
                                            {/* Prompt Tabs */}
                                            <div className="flex bg-black/20 p-1 rounded-lg border border-white/5 gap-1 shadow-inner">
                                                <button
                                                    onClick={() => setPromptTab('local')}
                                                    className={`flex-1 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-md transition-all cursor-pointer ${promptTab === 'local' ? 'bg-white text-black shadow-lg scale-[1.02]' : 'text-[#666] hover:text-[#aaa]'}`}
                                                >
                                                    Local (Ollama)
                                                </button>
                                                <button
                                                    onClick={() => setPromptTab('cloud')}
                                                    className={`flex-1 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-md transition-all cursor-pointer ${promptTab === 'cloud' ? 'bg-white text-black shadow-lg scale-[1.02]' : 'text-[#666] hover:text-[#aaa]'}`}
                                                >
                                                    Cloud (Venice)
                                                </button>
                                            </div>

                                            <div className="flex-1 flex flex-col min-h-0">
                                                {promptTab === 'local' ? (
                                                    <textarea
                                                        value={localPromptText}
                                                        onChange={(e) => setLocalPromptText(e.target.value)}
                                                        placeholder={defaultLocalPrompt || "Enter custom prompt..."}
                                                        className="flex-1 w-full p-4 bg-black/40 border border-white/10 rounded-xl text-sm text-gray-200 placeholder-white/20 focus:outline-none focus:border-white/30 resize-none font-mono selection:bg-purple-500/20"
                                                        spellCheck={false}
                                                    />
                                                ) : (
                                                    <textarea
                                                        value={cloudPromptText}
                                                        onChange={(e) => setCloudPromptText(e.target.value)}
                                                        placeholder={defaultCloudPrompt || "Enter custom prompt..."}
                                                        className="flex-1 w-full p-4 bg-black/40 border border-white/10 rounded-xl text-sm text-gray-200 placeholder-white/20 focus:outline-none focus:border-white/30 resize-none font-mono selection:bg-blue-500/20"
                                                        spellCheck={false}
                                                    />
                                                )}
                                            </div>

                                            <button
                                                onClick={async () => {
                                                    if (handle) {
                                                        await setCustomPrompt(handle, localPromptText || null, cloudPromptText || null);
                                                        setShowPromptEditor(false);
                                                    }
                                                }}
                                                disabled={!handle}
                                                className="w-full py-2.5 bg-blue-600 text-white rounded-xl text-[10px] font-bold hover:bg-blue-500 transition-all disabled:opacity-30 cursor-pointer uppercase tracking-widest shadow-lg shadow-blue-500/10"
                                            >
                                                Save Custom Prompt
                                            </button>
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
                                        <div className="text-gray-300 leading-relaxed whitespace-pre-wrap h-full flex flex-col">
 {isEditingTranscript ? (
    <div className="flex flex-col flex-1 min-h-0 gap-2">
        {!isPreviewingTranscript ? (
                                                        <div className="relative flex-1 min-h-[500px] bg-black/20 rounded-lg border border-[#333] focus-within:border-green-500 overflow-hidden">
                                                             <div
                                                                 ref={transcriptBackdropRef}
                                                                 className="absolute inset-0 w-full h-full p-3 m-0 border-none font-mono text-xs leading-relaxed whitespace-pre-wrap break-words overflow-y-auto pointer-events-none"
                                                                 style={{ color: 'transparent', scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                                                                 aria-hidden="true"
                                                             >
                                                                 {showFindReplace && searchIndices.length > 0 && currentSearchIndex !== -1 ? (
                                                                     <>
                                                                         {editedTranscript.substring(0, searchIndices[currentSearchIndex].start)}
                                                                         <mark className="bg-green-500/50 rounded-sm text-transparent" style={{ color: 'transparent' }}>
                                                                             {editedTranscript.substring(searchIndices[currentSearchIndex].start, searchIndices[currentSearchIndex].end)}
                                                                         </mark>
                                                                         {editedTranscript.substring(searchIndices[currentSearchIndex].end)}
                                                                     </>
                                                                 ) : (
                                                                     editedTranscript
                                                                 )}
                                                                 {editedTranscript.endsWith('\n') && <br />}
                                                             </div>
                                                            <textarea
                                                                ref={transcriptEditRef}
                                                                value={editedTranscript}
                                                                onChange={(e) => setEditedTranscript(e.target.value)}
                                                                onScroll={(e) => {
                                                                    if (transcriptBackdropRef.current) {
                                                                        transcriptBackdropRef.current.scrollTop = e.currentTarget.scrollTop;
                                                                        transcriptBackdropRef.current.scrollLeft = e.currentTarget.scrollLeft;
                                                                    }
                                                                }}
                                                                onKeyDown={(e) => {
                                                                    handleMarkdownKeyDown(e, editedTranscript, setEditedTranscript);
                                                                    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                                                                        e.preventDefault();
                                                                        setShowFindReplace(!showFindReplace);
                                                                    }
                                                                }}
                                                                className="absolute inset-0 w-full h-full p-3 m-0 border-none bg-transparent text-white outline-none text-xs leading-relaxed resize-none font-mono selection:bg-green-500/30"
                                                                spellCheck={false}
                                                            />
                                                        </div>
                                                    ) : (
                                                        <div className="flex-1 flex flex-col">
                                                            <div className="flex-1 relative rounded-lg border border-[#333] bg-black/20 overflow-hidden">
                                                                <div className="absolute inset-0 p-3 overflow-y-auto custom-scrollbar">
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
                                                                                     className="rounded-xl border border-white/10 cursor-pointer"
                                                                                     onClick={() => setFullscreenImage(props.src || '')}
                                                                                 />
                                                                             )
                                                                        }}
                                                                    >
                                                                        {editedTranscript}
                                                                    </ReactMarkdown>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    )}
                                                    <div className="flex justify-between items-center p-2">
                                                        <div
                                                            onClick={() => setIsPreviewingTranscript(!isPreviewingTranscript)}
                                                            className="cursor-pointer p-2 rounded-lg hover:bg-[#272727] transition-colors text-[#aaaaaa] hover:text-white"
                                                            title={isPreviewingTranscript ? "Back to Edit" : "Preview"}
                                                        >
                                                            {isPreviewingTranscript ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                                        </div>
                                                        <div className="flex gap-2">
                                                            <button
                                                                onClick={() => setIsEditingTranscript(false)}
                                                                className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#aaaaaa] hover:text-white transition-colors cursor-pointer"
                                                            >
                                                                Cancel
                                                            </button>
                                                            <button
                                                                onClick={handleSaveTranscript}
                                                                disabled={isSaving || isPreviewingTranscript}
                                                                className="px-4 py-1.5 bg-green-600 text-white dark:text-white rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-green-500 transition-colors disabled:opacity-30 cursor-pointer"
                                                            >
                                                                {isSaving ? "Saving..." : "Save Changes"}
                                                            </button>
                                                        </div>
                                                    </div>
                                                </div>

                                            ) : (
                                                transcript
                                            )}
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
                            
                            {/* Sticky Footer Area (Action Bar & Prompt) */}
                            {!isEditingTranscript && !isEditingSummary && (
                                <div className="mt-2 space-y-3 pt-3 border-t border-white/5">
                                     {/* Custom Prompt Editor */}
                                    {showCustomPrompt && pluginSummarizeEnabled && (
                                        <div className="p-3 bg-white/5 rounded-xl border border-white/5 relative z-20">
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#888888]">Custom Prompt</span>
                                                    <div className="group/hint relative flex items-center">
                                                        <Lightbulb className="w-3.5 h-3.5 text-[#666666] hover:text-orange-400 transition-colors cursor-help" />
                                                        <div className="absolute bottom-full left-0 mb-3 w-80 bg-[#1a1a1a] border border-[#333] rounded-xl p-4 opacity-0 translate-y-2 pointer-events-none group-hover/hint:opacity-100 group-hover/hint:translate-y-0 transition-all duration-200 z-[100] shadow-2xl">
                                                            <h4 className="text-[11px] font-bold text-gray-500 uppercase tracking-widest mb-3 border-b border-[#333] pb-2 flex items-center gap-2">
                                                                <Terminal className="w-3.5 h-3.5" />
                                                                Supported Variables
                                                            </h4>
                                                            <div className="space-y-4">
                                                                <div className="grid grid-cols-1 gap-1.5 pt-1 text-[11px]">
                                                                    <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                                        <span>{"${title}"}:</span>
                                                                        <span className="text-gray-500 group-hover/code:text-gray-300">Video title</span>
                                                                    </code>
                                                                    <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                                        <span>{"${author}"}:</span>
                                                                        <span className="text-gray-500 group-hover/code:text-gray-300">Channel name</span>
                                                                    </code>
                                                                    <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                                        <span>{"${handle}"}:</span>
                                                                        <span className="text-gray-500 group-hover/code:text-gray-300">Channel handle</span>
                                                                    </code>
                                                                    <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                                        <span>{"${length_seconds}"}:</span>
                                                                        <span className="text-gray-500 group-hover/code:text-gray-300">Video length</span>
                                                                    </code>
                                                                    <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                                        <span>{"${view_count}"}:</span>
                                                                        <span className="text-gray-500 group-hover/code:text-gray-300">View count</span>
                                                                    </code>
                                                                </div>
                                                                <p className="text-[10px] text-gray-400 leading-relaxed italic">
                                                                    These variables substitute dynamically when generating a summary from the library.
                                                                </p>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                                {(isLibrary || hasCustomPrompt) ? (
                                                    <button
                                                        onClick={() => setShowPromptEditor(!showPromptEditor)}
                                                        className="text-[#666666] hover:text-white transition-colors cursor-pointer text-[9px] uppercase font-bold"
                                                    >
                                                        {showPromptEditor ? 'Hide' : 'Show'}
                                                    </button>
                                                ) : (
                                                    <span className="text-[9px] text-[#666666] uppercase font-bold">(Save to Library to Edit)</span>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {/* Action Bar */}
                                    <div className="flex gap-2">
                                        <button
                                            onClick={handleCopy}
                                            disabled={loading || isTranscriptInvalid}
                                            className={`flex-1 py-1.5 rounded-lg border border-[#383838] bg-[#222222] text-white transition-all text-xs font-semibold disabled:opacity-20 ${loading || isTranscriptInvalid ? 'cursor-default' : 'hover:bg-[#3f3f3f] cursor-pointer'}`}
                                        >
                                            {copied ? "Copied" : "Copy Transcript"}
                                        </button>

                                        {existsInDb && onDelete && allowDeletion ? (
                                            <button
                                                onClick={onDelete}
                                                disabled={loading || isTranscriptInvalid || checkingDb || !hasApiKey}
                                                title={!hasApiKey ? "API not imported" : isTranscriptInvalid ? "No transcript to delete" : "Delete from Library"}
                                                className={`flex-1 py-1.5 rounded-lg bg-red-600 text-white transition-all text-xs font-bold disabled:opacity-20 flex items-center justify-center gap-2 ${loading || isTranscriptInvalid || checkingDb || !hasApiKey ? 'cursor-default' : 'hover:bg-red-500 cursor-pointer'}`}
                                            >
                                                <Trash2 className="w-3.5 h-3.5" />
                                                Delete
                                            </button>
                                        ) : !existsInDb ? (
                                            <button
                                                onClick={handleOnSave}
                                                disabled={loading || isTranscriptInvalid || checkingDb || !hasApiKey}
                                                title={!hasApiKey ? "API not imported" : isTranscriptInvalid ? "No transcript to save" : "Save to Library"}
                                                className={`flex-1 py-1.5 rounded-lg bg-red-600 text-white transition-all text-xs font-bold disabled:opacity-20 flex items-center justify-center gap-2 ${loading || isTranscriptInvalid || checkingDb || !hasApiKey ? 'cursor-default' : 'hover:bg-red-500 cursor-pointer'}`}
                                            >
                                                <Save className="w-3.5 h-3.5" />
                                                Save
                                            </button>
                                        ) : null}
                                    </div>
                                </div>
                            )}
                        </div>
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

            {/* Image Upload Error Modal */}
            {showImageUploadErrorModal && (
                <div className="fixed inset-0 bg-black/80 z-60 flex items-center justify-center p-4">
                    <div className="bg-[#1a1a1a] border border-[#303030] rounded-xl p-6 max-w-md w-full">
                        <h3 className="text-lg font-bold text-white mb-4">Image Insertion Failed</h3>
                        <p className="text-[#aaaaaa] text-sm mb-6 leading-relaxed">
                            Failed to upload image to Imgur: {imageUploadErrorMessage}
                        </p>
                        <div className="flex gap-3">
                            <button
                                onClick={() => {
                                    handleSaveImageAs(imageToSaveLocally);
                                    setShowImageUploadErrorModal(false);
                                }}
                                className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-500 transition-colors cursor-pointer"
                            >
                                Save Image Locally
                            </button>
                            <button
                                onClick={() => setShowImageUploadErrorModal(false)}
                                className="flex-1 py-2.5 bg-[#333333] text-white rounded-lg text-sm font-bold hover:bg-[#444444] transition-colors cursor-pointer"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}
        {/* Fullscreen Image Modal */}
        {fullscreenImage && (
            <div
                className="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-8 cursor-pointer"
                onClick={() => setFullscreenImage(null)}
            >
                <img
                    src={fullscreenImage}
                    alt="Fullscreen view"
                    className="max-w-full max-h-full object-contain"
                    onClick={(e) => e.stopPropagation()}
                />
            </div>
        )}
        </>
    );
}