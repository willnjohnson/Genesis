import { X, Trash2, Save, Sparkles, ArrowLeft, RotateCcw, Copy, Check, ExternalLink, Tags, Plus, Pencil, Image as ImageIcon, Search, Loader2, Upload, ChevronDown, ChevronUp, CaseSensitive, WholeWord, Terminal, Lightbulb, Eye, EyeOff } from 'lucide-react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { checkVideoExists, summarizeTranscript, getSummary, saveSummary, getSetting, openExternalUrl, getCustomPrompt, setCustomPrompt, getOllamaPrompt, getVenicePrompt, getGlossaryTerms, saveTranscript, searchPixabay, uploadToImgur, getPixabayApiKey, setPixabayApiKey, generateImage, fetchImageAsDataUri, saveImage, getVeniceApiKey, setVeniceApiKey } from '../api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TermDefinitionModal } from './TermDefinitionModal';
import photosynthesisLogo from '../assets/photosynthesis.png';

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
    onTagClick?: (term: GlossaryTerm) => void;
    onHandleClick?: (handle: string) => void;
    onAddTag?: (term: string) => void;
    onRemoveTag?: (term: string) => void;
    onSearchInLibrary?: (term: string, mode: 'title' | 'transcript' | 'tag') => void;
    initialTab?: 'transcript' | 'summary';
    showBiography?: boolean;
}

export const handleMarkdownKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>, value: string, setter: (val: string) => void) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') return;

    const target = e.currentTarget;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const selectedText = value.substring(start, end);

    const patterns: Record<string, { prefix: string; suffix: string; detect?: RegExp }> = {
        bold: { prefix: '**', suffix: '**', detect: /^\*\*(.*)\*\*$/s },
        italic: { prefix: '*', suffix: '*', detect: /^\*(.*)\*$/s },
        strikethrough: { prefix: '~~', suffix: '~~', detect: /^~~(.*)~~$/s },
        link: { prefix: '[', suffix: '](https://example.com)' },
        image: { prefix: '![', suffix: '](https://upload.wikimedia.org/wikipedia/commons/6/60/No-Image-Placeholder-banner.svg)' },
        blockquote: { prefix: '> ', suffix: '' },
    };

    const replaceSelection = (type: string, defaultText: string = "TEXT") => {
        e.preventDefault();
        const textToWrap = selectedText || defaultText;
        const { prefix, suffix, detect } = patterns[type];

        let replacement: string;
        let newSelectionStart: number;
        let newSelectionEnd: number;

        if (selectedText && detect) {
            const match = selectedText.match(detect);
            if (match) {
                // Unwrap: remove markdown
                replacement = match[1];
                newSelectionStart = start;
                newSelectionEnd = start + replacement.length;
            } else {
                // Wrap: add markdown and select full formatted text
                replacement = prefix + selectedText + suffix;
                newSelectionStart = start;
                newSelectionEnd = start + replacement.length;
            }
        } else {
            // No selection: insert with placeholder, select only inner text
            replacement = prefix + textToWrap + suffix;
            newSelectionStart = start + prefix.length;
            newSelectionEnd = start + prefix.length + textToWrap.length;
        }

        target.focus();
        document.execCommand('insertText', false, replacement);
        setTimeout(() => {
            target.setSelectionRange(newSelectionStart, newSelectionEnd);
        }, 0);
    };

    const prependLines = (getPrefix: (index: number) => string, stripPattern?: RegExp) => {
        e.preventDefault();
        const beforeSelection = value.substring(0, start);
        const lineStart = beforeSelection.lastIndexOf('\n') + 1;
        const afterSelection = value.substring(end);
        const lineEndOffset = afterSelection.indexOf('\n');
        const lineEnd = lineEndOffset === -1 ? value.length : end + lineEndOffset;

        const linesToModify = value.substring(lineStart, lineEnd).split('\n');
        const modifiedLines = linesToModify.map((line, i) => {
            const prefix = getPrefix(i);
            if (stripPattern) {
                const stripped = line.replace(stripPattern, '');
                return prefix + stripped;
            }
            return prefix + line;
        });
        const modifiedText = modifiedLines.join('\n');

        // Replace the full line range with modified text
        target.focus();
        target.setSelectionRange(lineStart, lineEnd);
        document.execCommand('insertText', false, modifiedText);
        setTimeout(() => {
            target.setSelectionRange(lineStart, lineStart + modifiedText.length);
        }, 0);
    };

    if (e.ctrlKey || e.metaKey) {
        if (!e.shiftKey && !e.altKey) {
            if (e.key.toLowerCase() === 'b') replaceSelection('bold');
            else if (e.key.toLowerCase() === 'i') replaceSelection('italic');
            else if (e.key.toLowerCase() === 'k') replaceSelection('link');
            else if (e.key.toLowerCase() === 'l') replaceSelection('image');
        } else if (e.shiftKey && !e.altKey) {
            if (e.key.toLowerCase() === 'x') replaceSelection('strikethrough');
            else if (e.key.toLowerCase() === 'l') prependLines(() => "- ");
            else if (e.code === 'Digit7' || e.key === '&') prependLines((i) => `${i + 1}. `);
            else if (e.key === '.' || e.key === '>') prependLines(() => "> ");
        } else if (e.altKey && !e.shiftKey) {
            if (['1','2','3','4','5','6'].includes(e.key)) {
                e.preventDefault();
                const level = parseInt(e.key);
                prependLines(() => "#".repeat(level) + " ", /^#+\s*/);
            }
        }
    }
};

export function Sidebar({ isOpen, onClose, transcript, loading, title, videoId, handle, onSave, onDelete, onRefetch, hasApiKey, pluginSummarizeEnabled, pluginPhotosynthesisEnabled, showSynthesizeVenice = true, showSynthesizePixabay = true, showSynthesizeUpload = true, onSummaryGenerated, cachedSummaries, onCacheSummary, allowDeletion = true, isLibrary = false, videoTags = [], onTagClick, onHandleClick, onAddTag, onRemoveTag, onSearchInLibrary, initialTab, showBiography = true }: Props) {
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
    const [promptTab, setPromptTab] = useState<'local' | 'cloud'>('local');
    const [glossaryTerms, setGlossaryTerms] = useState<GlossaryTerm[]>([]);
    const [showTagDropdown, setShowTagDropdown] = useState(false);
    const [tagFilter, setTagFilter] = useState("");
    const [selectedTerm, setSelectedTerm] = useState<GlossaryTerm | null>(null);
    const [isEditingTranscript, setIsEditingTranscript] = useState(false);
    const [isEditingSummary, setIsEditingSummary] = useState(false);
    const [editedTranscript, setEditedTranscript] = useState('');
    const [editedSummary, setEditedSummary] = useState('');
    const [summaryImageHover, setSummaryImageHover] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [imageTab, setImageTab] = useState<'venice' | 'pixabay' | 'upload'>('venice');
    const [pixabayQuery, setPixabayQuery] = useState("");
    const [pixabayImages, setPixabayImages] = useState<any[]>([]);
    const [isPixabayLoading, setIsPixabayLoading] = useState(false);
    const [pixabayApiKey, setPixabayApiKey] = useState("");
    const [pixabayApiKeySaved, setPixabayApiKeySaved] = useState(false);
    const [isGeneratingImage, setIsGeneratingImage] = useState(false);
    const [generatedImage, setGeneratedImage] = useState<string | null>(null);
    const [imagePrompt, setImagePrompt] = useState("");
    const [isUploadingImage, setIsUploadingImage] = useState(false);
    const [veniceApiKey, setVeniceApiKeyLocal] = useState("");
    const [veniceApiKeySaved, setVeniceApiKeySaved] = useState(false);

    // Find & Replace state
    const [findText, setFindText] = useState("");
    const [replaceText, setReplaceText] = useState("");
    const [matchCase, setMatchCase] = useState(false);
    const [matchWholeWord, setMatchWholeWord] = useState(false);
    const [searchIndices, setSearchIndices] = useState<{ start: number, end: number }[]>([]);
    const [currentSearchIndex, setCurrentSearchIndex] = useState(-1);
    const [showFindReplace, setShowFindReplace] = useState(false);
    const transcriptEditRef = useRef<HTMLTextAreaElement>(null);
    const summaryEditRef = useRef<HTMLTextAreaElement>(null);
    const transcriptBackdropRef = useRef<HTMLDivElement>(null);
    const summaryBackdropRef = useRef<HTMLDivElement>(null);

    const findMatches = useCallback(() => {
        const activeContent = isEditingTranscript ? editedTranscript : editedSummary;
        if (!findText) {
            setSearchIndices([]);
            setCurrentSearchIndex(-1);
            return;
        }

        const indices: { start: number, end: number }[] = [];
        let searchStr = findText;

        if (!matchCase) {
            searchStr = searchStr.toLowerCase();
        }

        const escapedFind = searchStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const patternStr = matchWholeWord 
            ? `(?<![a-zA-Z0-9])${escapedFind}(?![a-zA-Z0-9])`
            : escapedFind;
        
        const pattern = new RegExp(patternStr, matchCase ? 'g' : 'gi');

        let match;
        while ((match = pattern.exec(activeContent)) !== null) {
            indices.push({ start: match.index, end: match.index + match[0].length });
            if (match.index === pattern.lastIndex) pattern.lastIndex++; // safety
        }

        setSearchIndices(indices);
        setCurrentSearchIndex(indices.length > 0 ? 0 : -1);
    }, [findText, matchCase, matchWholeWord, isEditingTranscript, editedTranscript, editedSummary]);

    useEffect(() => {
        findMatches();
    }, [findText, matchCase, matchWholeWord, isEditingTranscript, editedTranscript, editedSummary]);

    useEffect(() => {
        if (!showFindReplace) {
            setFindText('');
            setReplaceText('');
        }
    }, [showFindReplace]);

    const highlightMatch = (idx: number, preventFocus: boolean = false) => {
        const activeTextareaRef = isEditingTranscript ? transcriptEditRef : summaryEditRef;
        const match = searchIndices[idx];
        if (!match || !activeTextareaRef.current) return;
        
        const textarea = activeTextareaRef.current;
        if (!preventFocus) textarea.focus();
        textarea.setSelectionRange(match.start, match.end);
        
        // Ensure the selection is visible
        const fullText = isEditingTranscript ? editedTranscript : editedSummary;
        const textBeforeMatch = fullText.substring(0, match.start);
        const linesBefore = textBeforeMatch.split('\n').length;
        const totalLines = fullText.split('\n').length;
        
        // This is a naive way to scroll but works for basic cases
        textarea.scrollTop = (linesBefore / totalLines) * textarea.scrollHeight - (textarea.clientHeight / 2);

        const activeBackdropRef = isEditingTranscript ? transcriptBackdropRef : summaryBackdropRef;
        if (activeBackdropRef.current) {
            activeBackdropRef.current.scrollTop = textarea.scrollTop;
        }
    };

    const navigateMatch = (dir: 'next' | 'prev', preventFocus: boolean = false) => {
        if (searchIndices.length === 0) return;
        let nextIdx = currentSearchIndex;
        if (dir === 'next') nextIdx = (currentSearchIndex + 1) % searchIndices.length;
        else nextIdx = (currentSearchIndex - 1 + searchIndices.length) % searchIndices.length;
        
        setCurrentSearchIndex(nextIdx);
        highlightMatch(nextIdx, preventFocus);
    };

    const handleReplace = () => {
        if (searchIndices.length === 0 || currentSearchIndex === -1) return;
        const match = searchIndices[currentSearchIndex];
        const activeTextareaRef = isEditingTranscript ? transcriptEditRef : summaryEditRef;
        
        if (activeTextareaRef.current) {
            const textarea = activeTextareaRef.current;
            textarea.focus();
            textarea.setSelectionRange(match.start, match.end);
            document.execCommand('insertText', false, replaceText);
        } else {
            // Fallback if ref is missing
            const activeContent = isEditingTranscript ? editedTranscript : editedSummary;
            const newContent = activeContent.substring(0, match.start) + replaceText + activeContent.substring(match.end);
            if (isEditingTranscript) setEditedTranscript(newContent);
            else setEditedSummary(newContent);
        }
    };

    const handleReplaceAll = () => {
        if (!findText) return;
        const activeContent = isEditingTranscript ? editedTranscript : editedSummary;
        const searchStr = findText;
        const escapedFind = searchStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const patternStr = matchWholeWord 
            ? `(?<![a-zA-Z0-9])${escapedFind}(?![a-zA-Z0-9])`
            : escapedFind;
        const pattern = new RegExp(patternStr, matchCase ? 'g' : 'gi');
        
        const newContent = activeContent.replace(pattern, replaceText);
        const activeTextareaRef = isEditingTranscript ? transcriptEditRef : summaryEditRef;

        if (activeTextareaRef.current) {
            const textarea = activeTextareaRef.current;
            textarea.focus();
            textarea.select();
            document.execCommand('insertText', false, newContent);
        } else {
            // Fallback
            if (isEditingTranscript) setEditedTranscript(newContent);
            else setEditedSummary(newContent);
        }
        setShowFindReplace(false);
    };

    const handleDeleteSummaryImage = (src: string) => {
        if (!src) return;

        const lines = editedSummary.split('\n');
        const newLines = lines.filter((line) => !line.includes(src));
        const cleanedSummary = newLines.join('\n').replace(/\n\n\n+/g, '\n\n').trim();

        setEditedSummary(cleanedSummary);
    };

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

    const handlePixabaySearch = async () => {
        if (!pixabayQuery.trim()) return;
        setIsPixabayLoading(true);
        try {
            const images = await searchPixabay(pixabayQuery);
            setPixabayImages(images);
        } catch (e: any) {
            console.error("Pixabay search failed:", e);
        } finally {
            setIsPixabayLoading(false);
        }
    };

    const handleGenerateVeniceImage = async () => {
        if (!imagePrompt.trim()) return;
        setIsGeneratingImage(true);
        setGeneratedImage(null);
        try {
            const dataUri = await generateImage(imagePrompt);
            setGeneratedImage(dataUri);
        } catch (e: any) {
            console.error("Venice image gen failed:", e);
        } finally {
            setIsGeneratingImage(false);
        }
    };

    const handleAddImageToContent = async (imageUrl: string, tags: string) => {
        setIsUploadingImage(true);
        try {
            const imgurUrl = await uploadToImgur(imageUrl);
            const markdown = `![${tags}](${imgurUrl})\n\n`;
            if (isEditingTranscript) {
                setEditedTranscript(prev => markdown + prev);
            } else if (isEditingSummary) {
                setEditedSummary(prev => markdown + prev);
            }
        } catch (e: any) {
            console.error("Failed to add image:", e);
        } finally {
            setIsUploadingImage(false);
        }
    };

    const handleSaveImageAs = async (url: string) => {
        try {
            let dataUri = url;
            if (!url.startsWith('data:')) {
                dataUri = await fetchImageAsDataUri(url);
            }
            if (!dataUri) return;

            const filePath = await save({
                filters: [{ name: 'Image', extensions: ['webp'] }],
                defaultPath: 'generated-image.webp'
            });
            
            if (filePath) {
                const parts = dataUri.split(',');
                const base64 = parts.length > 1 ? parts[1] : parts[0];
                await saveImage(filePath, base64);
            }
        } catch (e: any) {
            console.error("Save failed:", e);
        }
    };

    const handleSaveVeniceApiKey = async () => {
        if (!veniceApiKey.trim()) return;
        try {
            await setVeniceApiKey(veniceApiKey);
            setVeniceApiKeySaved(true);
        } catch (err) {
            console.error("Failed to save Venice API key:", err);
        }
    };

    const handleSavePixabayApiKey = async () => {
        if (!pixabayApiKey.trim()) return;
        try {
            await setPixabayApiKey(pixabayApiKey);
            setPixabayApiKeySaved(true);
        } catch (err) {
            console.error("Failed to save Pixabay API key:", err);
        }
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
            setSummary(editedSummary);
            if (onCacheSummary) onCacheSummary(videoId, editedSummary);
            setIsEditingSummary(false);
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

            getPixabayApiKey().then(key => {
                if (key) {
                    setPixabayApiKey(key);
                    setPixabayApiKeySaved(true);
                }
            });

            getVeniceApiKey().then(key => {
                if (key) {
                    setVeniceApiKeyLocal(key);
                    setVeniceApiKeySaved(true);
                }
            });
        } else {
            document.body.style.overflow = 'auto';
            // Clear image prompt and Pixabay search results when sidebar closes
            setImagePrompt('');
            setPixabayImages([]);
            setGeneratedImage(null);
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
            setIsEditingSummary(false);
            setIsEditingTranscript(false);
            return;
        }

        setIsEditingSummary(false);
        setIsEditingTranscript(false);

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
    }, [videoId, isOpen, pluginSummarizeEnabled, cachedSummaries, initialTab]);

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
            const result = await summarizeTranscript(transcript, handle, videoId);
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
        setIsEditingSummary(false);
        setIsEditingTranscript(false);
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

                    <div className="flex-1 flex overflow-hidden relative">
                        {/* Left Side: Video Player or Image Tools */}
                        <div
                            style={{ width: `${splitPercent}%` }}
                            className="border-r border-gray-900 bg-black/20 flex flex-col h-full overflow-hidden"
                        >
                            {(pluginPhotosynthesisEnabled && showSummary && isEditingSummary) ? (
                                <div className="flex flex-col h-full bg-transparent relative">
                                    {/* Image Tool Header */}
                                    <div className="px-6 py-4 border-b border-[#303030] flex flex-col gap-4 bg-white/5">
                                        <div className="flex items-center gap-2">
                                            <img src={photosynthesisLogo} alt="Photosynthesis" className="w-5 h-5" />
                                            <div className="flex flex-col -gap-0.5">
                                                <span className="text-xs font-bold tracking-tight text-white">Photosynthesis</span>
                                                <span className="text-[9px] text-gray-500 font-medium uppercase tracking-wider">Synthesize your photos with AI</span>
                                            </div>
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <div className="flex gap-2">
                                            {showSynthesizeVenice && (
                                                <button
                                                    id="venice-tab-btn"
                                                    onClick={() => setImageTab('venice')}
                                                    className={`flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer px-4 py-2 rounded-lg ${imageTab === 'venice'
                                                        ? 'bg-red-600 text-white'
                                                        : 'bg-[#222222] text-[#888888] hover:text-white border border-[#383838]'}`}
                                                >
                                                    <ImageIcon className="w-3 h-3" />
                                                    Venice
                                                </button>
                                            )}
                                            {showSynthesizePixabay && (
                                                <button
                                                    id="pixabay-tab-btn"
                                                    onClick={() => setImageTab('pixabay')}
                                                    className={`flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer px-4 py-2 rounded-lg ${imageTab === 'pixabay'
                                                        ? 'bg-blue-600 text-white'
                                                        : 'bg-[#222222] text-[#888888] hover:text-white border border-[#383838]'}`}
                                                >
                                                    <Search className="w-3 h-3" />
                                                    Pixabay
                                                </button>
                                            )}
                                            {showSynthesizeUpload && (
                                                <button
                                                    id="upload-tab-btn"
                                                    onClick={() => setImageTab('upload')}
                                                    className={`flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer px-4 py-2 rounded-lg ${imageTab === 'upload'
                                                        ? 'bg-green-600 text-white'
                                                        : 'bg-[#222222] text-[#888888] hover:text-white border border-[#383838]'}`}
                                                >
                                                    <Upload className="w-3 h-3" />
                                                    Upload
                                                </button>
                                            )}
                                        </div>
                                        <span className="text-[10px] font-bold uppercase tracking-widest text-[#666] italic">
                                            {imageTab === 'venice' ? "Generate with AI" : imageTab === 'pixabay' ? "Search Photos" : "Upload Local"}
                                        </span>
                                    </div>
                                </div>

                                {/* Image Tool Content */}
                                    <div className="flex-1 overflow-y-auto p-6 custom-scrollbar bg-transparent">
                                        {imageTab === 'venice' ? (
                                            <div className="space-y-4">
                                                {!veniceApiKeySaved ? (
                                                    <div className="space-y-3">
                                                        <p className="text-[10px] font-bold uppercase tracking-wider text-[#888888]">Venice API Key</p>
                                                        <div className="flex gap-2">
                                                            <input
                                                                type="password"
                                                                value={veniceApiKey}
                                                                onChange={(e) => setVeniceApiKeyLocal(e.target.value)}
                                                                placeholder="API Key..."
                                                                className="flex-1 bg-[#222222] border border-[#383838] rounded-lg px-4 py-2 text-sm text-white placeholder-[#666666] focus:outline-none focus:border-red-500"
                                                            />
                                                            <button
                                                                onClick={handleSaveVeniceApiKey}
                                                                className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-bold hover:bg-red-500 transition-colors cursor-pointer"
                                                            >
                                                                Save
                                                            </button>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <div className="space-y-4">
                                                        <p className="text-[10px] font-bold uppercase tracking-wider text-[#888888]">Image Prompt</p>
                                                        <div className="flex flex-wrap gap-2">
                                                            {['Infographic', 'Visual Poster', 'Concept Art', 'Scene Illustration', 'Data Viz', 'Flowchart', 'Whiteboard'].map(tag => (
                                                                <button
                                                                    key={tag}
                                                                    onClick={() => {
                                                                        const content = isEditingTranscript ? editedTranscript : editedSummary;
                                                                        const type = isEditingTranscript ? "this transcript" : "this AI summary";
                                                                        setImagePrompt(`${tag} based on ${type}:\n\n${content}`);
                                                                    }}
                                                                    className="px-2 py-1 rounded-lg bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] cursor-pointer text-white text-xs font-semibold transition-colors"
                                                                >
                                                                    {tag}
                                                                </button>
                                                            ))}
                                                        </div>
                                                        <textarea
                                                            id="image-prompt-input"
                                                            value={imagePrompt}
                                                            onChange={(e) => setImagePrompt(e.target.value)}
                                                            placeholder="Enter image prompt..."
                                                            className="w-full h-48 bg-[#222222] border border-[#383838] rounded-lg px-4 py-2 text-sm text-white placeholder-[#666666] focus:outline-none focus:border-red-500 resize-none"
                                                        />
                                                        <div className="flex gap-2">
                                                            <button
                                                                id="generate-image-btn"
                                                                onClick={handleGenerateVeniceImage}
                                                                disabled={isGeneratingImage || !imagePrompt.trim()}
                                                                className="bg-red-600 hover:bg-red-500 disabled:opacity-30 text-white px-4 py-2 rounded-lg text-sm font-bold transition-all flex items-center gap-2 cursor-pointer"
                                                            >
                                                                {isGeneratingImage ? <Loader2 className="w-4 h-4 animate-spin" /> : "Generate"}
                                                            </button>
                                                            <button
                                                                onClick={() => setVeniceApiKeySaved(false)}
                                                                className="bg-[#444] hover:bg-[#555] text-white px-3 py-2 rounded-lg text-sm font-bold transition-all cursor-pointer"
                                                                title="Update API Key"
                                                            >
                                                                Edit Key
                                                            </button>
                                                        </div>
                                                    </div>
                                                )}

                                                {generatedImage && (
                                                    <div className="flex flex-col gap-2 pt-4 border-t border-white/5">
                                                        <p className="text-[10px] font-bold uppercase tracking-wider text-[#888888]">Generated Image</p>
                                                        <div
                                                            onClick={() => handleAddImageToContent(generatedImage, "AI Generated Image")}
                                                            onContextMenu={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                handleSaveImageAs(generatedImage);
                                                            }}
                                                            className="relative group rounded-lg overflow-hidden cursor-pointer inline-block w-full border border-white/5"
                                                        >
                                                            <img
                                                                src={generatedImage}
                                                                alt="Generated"
                                                                className="w-full rounded-lg"
                                                                onContextMenu={(e) => {
                                                                    e.preventDefault();
                                                                    e.stopPropagation();
                                                                    handleSaveImageAs(generatedImage);
                                                                }}
                                                            />
                                                            <div 
                                                                className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none"
                                                            >
                                                                <div className="pointer-events-none">
                                                                    {isUploadingImage ? <Loader2 className="w-6 h-6 animate-spin text-white" /> : <Upload className="w-6 h-6 text-white" />}
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <p className="text-[10px] text-gray-500">Right-click to Save As • Click to Add to Content</p>
                                                    </div>
                                                )}
                                            </div>
                                        ) : imageTab === 'pixabay' ? (
                                            <div className="space-y-4">
                                                {!pixabayApiKeySaved ? (
                                                    <div className="space-y-3">
                                                        <p className="text-[10px] font-bold uppercase tracking-wider text-[#888888]">Pixabay API Key</p>
                                                        <div className="flex gap-2">
                                                            <input
                                                                id="pixabay-api-key-input"
                                                                type="password"
                                                                value={pixabayApiKey}
                                                                onChange={(e) => setPixabayApiKey(e.target.value)}
                                                                placeholder="API Key..."
                                                                className="flex-1 bg-[#222222] border border-[#383838] rounded-lg px-4 py-2 text-sm text-white placeholder-[#666666] focus:outline-none focus:border-red-500"
                                                            />
                                                            <button
                                                                id="save-pixabay-key-btn"
                                                                onClick={handleSavePixabayApiKey}
                                                                className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-bold hover:bg-green-500 transition-colors cursor-pointer"
                                                            >
                                                                Save
                                                            </button>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <div className="space-y-4">
                                                        <p className="text-[10px] font-bold uppercase tracking-wider text-[#888888]">Search Pixabay</p>
                                                        <div className="flex gap-2">
                                                            <input
                                                                id="pixabay-search-input"
                                                                type="text"
                                                                value={pixabayQuery}
                                                                onChange={(e) => setPixabayQuery(e.target.value)}
                                                                onKeyDown={(e) => e.key === 'Enter' && handlePixabaySearch()}
                                                                placeholder="Search Pixabay..."
                                                                className="flex-1 bg-[#222222] border border-[#383838] rounded-lg px-4 py-2 text-sm text-white placeholder-[#666666] focus:outline-none focus:border-red-500"
                                                            />
                                                            <button
                                                                onClick={handlePixabaySearch}
                                                                disabled={!pixabayQuery.trim() || isPixabayLoading}
                                                                className="bg-blue-600 hover:bg-blue-500 disabled:opacity-30 text-white px-4 py-2 rounded-lg text-sm font-bold transition-all flex items-center gap-2 cursor-pointer"
                                                            >
                                                                {isPixabayLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Search"}
                                                            </button>
                                                            <button
                                                                onClick={() => setPixabayApiKeySaved(false)}
                                                                className="bg-[#444] hover:bg-[#555] text-white px-3 py-2 rounded-lg text-sm font-bold transition-all cursor-pointer"
                                                                title="Update API Key"
                                                            >
                                                                Edit Key
                                                            </button>
                                                        </div>

                                                        {isUploadingImage && (
                                                            <div className="flex items-center justify-center py-2">
                                                                <Loader2 className="w-4 h-4 animate-spin text-blue-500 mr-2" />
                                                                <span className="text-xs text-blue-500">Uploading to Imgur...</span>
                                                            </div>
                                                        )}

                                                        <div className="grid grid-cols-4 gap-2 max-h-[400px] overflow-y-auto pr-1 custom-scrollbar">
                                                            {pixabayImages.map(img => (
                                                                <div
                                                                    key={img.id}
                                                                    onClick={() => handleAddImageToContent(img.url, img.tags)}
                                                                    onContextMenu={(e) => {
                                                                        e.preventDefault();
                                                                        e.stopPropagation();
                                                                        handleSaveImageAs(img.url);
                                                                    }}
                                                                    className="relative group rounded-lg overflow-hidden cursor-pointer border border-white/5"
                                                                >
                                                                    <img 
                                                                        src={img.thumbnail} 
                                                                        alt={img.tags} 
                                                                        className="w-full h-20 object-cover" 
                                                                        onContextMenu={(e) => {
                                                                            e.preventDefault();
                                                                            e.stopPropagation();
                                                                            handleSaveImageAs(img.url);
                                                                        }}
                                                                    />
                                                                    <div 
                                                                        className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none"
                                                                    >
                                                                        {isUploadingImage ? <Loader2 className="w-4 h-4 animate-spin text-white" /> : <Upload className="w-4 h-4 text-white" />}
                                                                    </div>
                                                                </div>
                                                            ))}
                                                        </div>

                                                        {pixabayImages.length === 0 && !isPixabayLoading && (
                                                            <div className="flex flex-col items-center justify-center py-12 text-[#444]">
                                                                <Search className="w-8 h-8 mb-2 opacity-20" />
                                                                <p className="text-[10px] font-bold uppercase tracking-widest text-[#666]">No images found</p>
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        ) : (
                                            <div className="h-full flex flex-col items-center justify-center space-y-6">
                                                <div 
                                                    onClick={() => document.getElementById('local-image-upload')?.click()}
                                                    onDragOver={(e) => { e.preventDefault(); }}
                                                    onDragLeave={(e) => { e.preventDefault(); }}
                                                    onDrop={async (e) => {
                                                        e.preventDefault();
                                                        const file = e.dataTransfer.files[0];
                                                        if (file && file.type.startsWith('image/')) {
                                                            const reader = new FileReader();
                                                            reader.onload = (re) => {
                                                                const dataUri = re.target?.result as string;
                                                                handleAddImageToContent(dataUri, file.name);
                                                            };
                                                            reader.readAsDataURL(file);
                                                        }
                                                    }}
                                                    className="w-full border-2 border-dashed border-[#383838] rounded-2xl p-12 flex flex-col items-center justify-center gap-4 cursor-pointer"
                                                >
                                                    <div className="w-16 h-16 rounded-full bg-green-600/10 flex items-center justify-center">
                                                        {isUploadingImage ? <Loader2 className="w-8 h-8 animate-spin text-green-500" /> : <Upload className="w-8 h-8 text-green-500" />}
                                                    </div>
                                                    <div className="text-center">
                                                        <p className="text-sm font-bold text-white mb-1">Click or Drag Image</p>
                                                        <p className="text-[10px] text-[#666] uppercase tracking-widest">Supports PNG, JPG, WEBP</p>
                                                    </div>
                                                    <input 
                                                        id="local-image-upload"
                                                        type="file" 
                                                        accept="image/*" 
                                                        className="hidden" 
                                                        onChange={(e) => {
                                                            const file = e.target.files?.[0];
                                                            if (file) {
                                                                const reader = new FileReader();
                                                                reader.onload = (re) => {
                                                                    const dataUri = re.target?.result as string;
                                                                    handleAddImageToContent(dataUri, file.name);
                                                                };
                                                                reader.readAsDataURL(file);
                                                            }
                                                        }}
                                                    />
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ) : (
                                <div className="flex-1 overflow-y-auto p-6 flex flex-col custom-scrollbar">
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
                                                    <button
                                                        onClick={handleBackToTranscript}
                                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-[#272727] text-[#aaaaaa] rounded-lg hover:text-white hover:bg-[#3f3f3f] transition-colors text-[10px] font-bold uppercase tracking-wider cursor-pointer"
                                                    >
                                                        <ArrowLeft className="w-3 h-3" />
                                                        Back to Transcript
                                                    </button>
                                                ) : (
                                                    !isEditingTranscript && !isEditingSummary && (pluginSummarizeEnabled || hasExistingSummary) && (
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
                                                {(isEditingTranscript || isEditingSummary) && (
                                                    <button
                                                        onClick={() => setShowFindReplace(!showFindReplace)}
                                                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all text-[10px] font-bold uppercase tracking-wider cursor-pointer ${showFindReplace ? 'bg-blue-600 text-white' : 'bg-[#272727] text-[#aaaaaa] hover:text-white hover:bg-[#3f3f3f]'}`}
                                                    >
                                                        <Search className="w-3 h-3" />
                                                        {showFindReplace ? 'Close Find' : 'Find & Replace'}
                                                    </button>
                                                )}
                                                {!showSummary && !isEditingTranscript && pluginPhotosynthesisEnabled && (
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
                                                     {showFindReplace && (
                                                         <div className="relative p-2.5 bg-[#1a1a1a] rounded-xl border border-[#303030] flex flex-col gap-2 animate-in fade-in slide-in-from-top-2 duration-200 z-50 mb-1">
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
                                                     )}
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
                                                             {editedSummary.endsWith('\\n') && <br />}
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
                                                                                            className="rounded-xl border border-white/10"
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
                                                                        className="rounded-xl border border-white/10"
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
        {showFindReplace && (
                                                        <div className="relative p-2.5 bg-[#1a1a1a] rounded-xl border border-[#303030] flex flex-col gap-2 animate-in fade-in slide-in-from-top-2 duration-200 z-50 mb-2">
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
                                                    )}
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
                                                                                    className="rounded-xl border border-white/10"
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
        </>
    );
}