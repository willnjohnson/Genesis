import { X, Trash2, Save, Sparkles, ArrowLeft, RotateCcw, ClipboardPaste, Check, ExternalLink, Pencil, Search, Terminal, Lightbulb, Eye, EyeOff, Plus, Tags, BookA, ListVideo, Paperclip, Monitor, Cloud } from 'lucide-react';
import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { LifeLoader } from './LifeLoader';
import { checkVideoExists, summarizeTranscript, getSummary, saveSummary, getSetting, setSetting, openExternalUrl, getCustomPrompt, setCustomPrompt, getOllamaPrompt, getVenicePrompt, getGlossaryTerms, saveTranscript, getEmbedServerPort, updateVideoWdbs, decodeWdbs, encodeWdbs, getWdbsSuggestions, getVideoWdbs, getVideoWdbsLinks, addVideoWdbsLink, removeVideoWdbsLink, getSimilarVideos, getWdbsAliases, getHandleDrives, getVideoById, getVideoAttachments, type Video, type GlossaryTerm } from '../api';
import { DriveComboBox } from './DriveComboBox';
import { saveImageAs } from '../lib/save-image-as';
import { handleMarkdownKeyDown, handleMarkdownContextMenu } from '../lib/markdown-editor';
import { useFindReplace } from './sidebar/useFindReplace';
import { FindReplacePanel } from './sidebar/FindReplacePanel';
import { GlossaryDetectPanel } from './sidebar/GlossaryDetectPanel';
import { ConfirmDialog } from './ConfirmDialog';
import { TranscriptText } from './sidebar/TranscriptText';
import { useReadFind } from './sidebar/useReadFind';
import { PhotosynthesisPanel } from './sidebar/PhotosynthesisPanel';
import { VideoTagsPanel } from './sidebar/VideoTagsPanel';
import { SequenceDock } from './sidebar/SequenceDock';
import { SimilarVideosPanel } from './sidebar/SimilarVideosPanel';
import { AttachmentsPanel } from './sidebar/AttachmentsPanel';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkHighlight } from '../lib/remark-highlight';
import { remarkSourceLines, lineAt, indexOfLine, caretY, scrollPreviewToLine, topVisibleLine } from '../lib/preview-sync';
import { markdownUrlTransform } from '../lib/internal-links';
import { MarkdownLink } from './MarkdownLink';
import { TermDefinitionModal } from './TermDefinitionModal';
import { useWorkspace } from '../hooks/useWorkspace';
import { driveSegmentLabel } from '../lib/utils';
import { useFlags } from '../hooks/useFlags';

type LeftTab = 'terms' | 'tags' | 'similar' | 'attachments';

// Persisted in the generic `Settings` table (see api.ts's getSetting/setSetting) so the
// video/transcript split ratio survives closing and reopening the sidebar, and relaunching
// the app, instead of resetting to the 65% default every time.
const SPLIT_PERCENT_SETTING_KEY = 'sidebarSplitPercent';
// The divider is a percentage, which on a narrow window leaves the transcript pane too thin to hold its
// header buttons or a readable line. So each pane also has a pixel floor. On a window too small for both,
// the transcript pane keeps its floor and the video pane gets what's left.
const MIN_VIDEO_PANE_PX = 300;
const MIN_TRANSCRIPT_PANE_PX = 340;
// The panel is 1378px wide at most until the window is wide enough to leave a strip of the page showing to its
// left (the click-outside-to-close area): that strip is what a 1440px window shows (1440 - 1378 = 62px, enough
// to clear the Kinesis "K" logo in the navigation rail), and beyond that width the panel grows with the window
// and keeps the strip the same. The transcript / AI summary side keeps the width it has at 1378px; all the extra
// goes to the video side.
const SIDEBAR_BASE_WIDTH = 1378;
const SIDEBAR_SIDE_GAP = 62;
/** The divider position (percent from the left) held within the 30-85 range and both panes' floors. */
function clampSplit(percent: number, sidebarWidth: number): number {
    let lo = 30;
    let hi = 85;
    if (sidebarWidth > 0) {
        lo = Math.max(lo, (MIN_VIDEO_PANE_PX / sidebarWidth) * 100);
        hi = Math.min(hi, 100 - (MIN_TRANSCRIPT_PANE_PX / sidebarWidth) * 100);
    }
    if (lo > hi) return Math.max(0, hi);
    return Math.min(hi, Math.max(lo, percent));
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
    /** The transcript was replaced by hand (pasted in): the app keeps this text as the video's transcript. */
    onTranscriptChange?: (text: string) => void;
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
    onSearchInLibrary?: (term: string, mode: 'tag' | 'term' | 'library') => void;
    initialTab?: 'transcript' | 'summary';
    showBiography?: boolean;
    allowEditTranscriptOnNA?: boolean;
    wdbs?: string;
    allowEditWDBS?: boolean;
    onWdbsUpdated?: (wdbs: string) => void;
    // Fired after ANY successful WDBS mutation here — primary designator change, or a symlink
    // added/removed — so the caller can refresh views that show WDBS assignments but live outside
    // this panel (e.g. App.tsx's Drive/Warp Drive tree, whose per-category counts otherwise go
    // stale the moment they're rendered). `onWdbsUpdated` above only covers the primary value and
    // only updates this same video's own local state, not those other views.
    onWdbsChanged?: () => void;
    // Makes the video's Drive and "Also in" tags clickable: closes this panel and shows that Drive in
    // the Library/Portal. `path` is the storage form, `label` the name the tree shows for it.
    onSelectDrive?: (path: string, label: string) => void;
    // The Drive picked in the Library's Drive panel (storage form), if any. The sequence bar follows
    // that Drive's sequence when it holds the video being shown.
    driveContext?: string | null;
    // Swaps the Sidebar to show a different video in place (used by the Similar Videos tab) —
    // same callback App.tsx already passes to VideoList/BiographyModal for this purpose.
    onVideoSelect?: (video: Video) => void;
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
export function Sidebar({ isOpen, onClose, transcript, loading, title, videoId, handle, onSave, onDelete, onRefetch, onTranscriptChange, pluginSummarizeEnabled, pluginPhotosynthesisEnabled, showSynthesizeVenice = true, showSynthesizePixabay = true, showSynthesizeUpload = true, onSummaryGenerated, cachedSummaries, onCacheSummary, allowDeletion = true, isLibrary = false, videoTags = [], onHandleClick, onAddTag, onRemoveTag, onSearchInLibrary, initialTab, showBiography = true, allowEditTranscriptOnNA = true, wdbs, allowEditWDBS = false, onWdbsUpdated, onWdbsChanged, onSelectDrive, driveContext, onVideoSelect }: Props) {
    const [copied, setCopied] = useState(false);
    const [summaryCopied, setSummaryCopied] = useState(false);
    const [existsInDb, setExistsInDb] = useState(false);
    const [checkingDb, setCheckingDb] = useState(false);
    const [splitPercent, setSplitPercent] = useState(65);
    const splitPercentRef = useRef(splitPercent);
    // The panel's width follows the window, so the pane floors are applied against it as it changes.
    const [sidebarWidth, setSidebarWidth] = useState(0);
    useEffect(() => {
        const el = document.getElementById('sidebar-container');
        if (!el) return;
        const observer = new ResizeObserver(() => setSidebarWidth(el.offsetWidth));
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    // splitPercent is a share of the panel at its base width (at most 1378px); a wider panel keeps the
    // transcript side at that same pixel width and gives the rest to the video side.
    const baseWidth = Math.min(sidebarWidth, SIDEBAR_BASE_WIDTH);
    const transcriptPx = ((100 - clampSplit(splitPercent, baseWidth)) / 100) * baseWidth;
    const effectiveSplit = sidebarWidth > 0 ? (1 - transcriptPx / sidebarWidth) * 100 : splitPercent;
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
    const [isEditingWdbs, setIsEditingWdbs] = useState(false);
    const [wdbsInput, setWdbsInput] = useState('');
    const [wdbsError, setWdbsError] = useState<string | null>(null);
    const [savingWdbs, setSavingWdbs] = useState(false);
    const [wdbsSuggestions, setWdbsSuggestions] = useState<string[]>([]);
    // Drives this video's channel already appears in elsewhere (see DriveComboBox's Suggested
    // section) — refetched whenever the channel changes, not per-video, since it depends only on
    // the handle.
    const [channelSuggestedDrives, setChannelSuggestedDrives] = useState<string[]>([]);
    const [wdbsLinks, setWdbsLinks] = useState<string[]>([]);
    // Curated aliases of this video's Drive and "Also in" tags (storage path -> alias), shown as the
    // tags' tooltips. Only Drives that have one are in here.
    const [wdbsAliases, setWdbsAliases] = useState<Record<string, string>>({});
    const [leftTab, setLeftTab] = useState<LeftTab>('terms');
    // The Drive whose sequence the bar under the video follows from one video to the next (set by
    // choosing one in the bar's dropdown or by moving with First / Previous / Next). Cleared when the
    // Library's Drive selection changes, so picking a different Drive there is followed.
    const [activeSeqDrive, setActiveSeqDrive] = useState<string | null>(null);
    useEffect(() => { setActiveSeqDrive(null); }, [driveContext]);
    const openSequenceVideo = useCallback((id: string) => {
        getVideoById(id).then(v => { if (v) onVideoSelect?.(v); }).catch(() => {});
    }, [onVideoSelect]);
    // Feature flags a DB owner sets (see lib/flags.ts): parts of this panel can be hidden or made read-only.
    const { flags } = useFlags();
    const { labels } = useWorkspace();
    // Terms (glossary entries with a definition) and Tags (Quick Tags, no definition) are separate
    // tabs; showVideoTags turns both on, and showQuickTags off also drops Tags.
    const showTermsTab = flags.showVideoTags;
    const showTagsTab = flags.showVideoTags && flags.showQuickTags;
    const availableLeftTabs = ([showTermsTab && 'terms', showTagsTab && 'tags', flags.showSimilarVideos && 'similar', flags.showAttachments && 'attachments'].filter(Boolean)) as LeftTab[];
    const activeLeftTab = availableLeftTabs.includes(leftTab) ? leftTab : availableLeftTabs[0];
    const [similarVideos, setSimilarVideos] = useState<Video[]>([]);
    const [loadingSimilar, setLoadingSimilar] = useState(false);
    const fetchedSimilarForRef = useRef<string | null>(null);
    // For the badge on the Attachments tab. Fetched eagerly (not lazily, like Similar Videos above)
    // since the whole point is to show a cue without the user opening the tab first; kept in sync
    // afterwards by AttachmentsPanel's onCountChange as files/links are added or removed.
    const [attachmentCount, setAttachmentCount] = useState(0);
    // The video's actual canonical WDBS, looked up from the database rather than trusted from the
    // `wdbs` prop — a video opened from Search carries a freshly-fetched YouTube `Video` object
    // that never has `wdbs` set, even when that video is already saved locally with one (see
    // api.ts's getVideoWdbs). Falls back to the prop so a Library-opened video (which does carry
    // its real value already) renders immediately without waiting on the round trip.
    const [primaryWdbs, setPrimaryWdbs] = useState<string | undefined>(wdbs);
    const [isAddingLink, setIsAddingLink] = useState(false);
    const [linkInput, setLinkInput] = useState('');
    const [linkError, setLinkError] = useState<string | null>(null);
    const [savingLink, setSavingLink] = useState(false);

    const transcriptEditRef = useRef<HTMLTextAreaElement>(null);
    const summaryEditRef = useRef<HTMLTextAreaElement>(null);
    const transcriptBackdropRef = useRef<HTMLDivElement>(null);
    const summaryBackdropRef = useRef<HTMLDivElement>(null);

    // How much the buttons in the transcript/summary header row say: full labels, then short ones
    // ("Back", "Find", "Detect"), then just their icons. Which tier fits depends on how many buttons the
    // row has (editing adds Find & Replace and Detect Glossary beside Back) as well as its width, which
    // the draggable divider (splitPercent) changes along with the window, so it's found by trying: start
    // from full whenever the width or the set of buttons changes, and step down while they don't fit.
    // Room kept between the title and the buttons: a tier is dropped while there is still this much to
    // spare, so the two never get close enough to touch.
    const HEADER_BUTTONS_SLACK = 20;
    const transcriptHeaderRef = useRef<HTMLDivElement>(null);
    const headerButtonsRef = useRef<HTMLDivElement>(null);
    const [headerWidth, setHeaderWidth] = useState(0);
    const [headerActionMode, setHeaderActionMode] = useState<'full' | 'short' | 'icon'>('full');
    useEffect(() => {
        const el = transcriptHeaderRef.current;
        if (!el) return;
        // flushSync: the tier is re-chosen before the browser paints, so a drag of the divider never shows
        // a frame with the buttons on top of the title.
        const observer = new ResizeObserver(([entry]) => flushSync(() => setHeaderWidth(entry.contentRect.width)));
        observer.observe(el);
        return () => observer.disconnect();
    }, []);


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

    // Asked before opening the transcript editor when summarizing replaces the transcript with N/A.
    const [confirmEditTranscript, setConfirmEditTranscript] = useState(false);
    const startEditingTranscript = () => {
        setIsEditingTranscript(true);
        setIsEditingSummary(false);
        setEditedTranscript(transcript);
    };

    // "Detect Glossary": suggests glossary terms in the text being edited to link (never on its own).
    // It shares the editor's top-right corner with Find & Replace, so opening one closes the other.
    const [showGlossaryDetect, setShowGlossaryDetect] = useState(false);
    // Ctrl+F while reading the transcript or AI summary: search-only (no Replace), see useReadFind.
    const [showReadFind, setShowReadFind] = useState(false);
    useEffect(() => {
        if (!isEditingTranscript && !isEditingSummary) setShowGlossaryDetect(false);
    }, [isEditingTranscript, isEditingSummary]);
    // Header button labels (see headerActionMode above): back to full whenever the width or the set of
    // buttons changes, then down a tier for as long as they overflow.
    useLayoutEffect(() => {
        setHeaderActionMode('full');
    }, [headerWidth, showSummary, isEditingTranscript, isEditingSummary, showPromptEditor, showFindReplace, showGlossaryDetect, pluginSummarizeEnabled, hasExistingSummary]);
    useLayoutEffect(() => {
        const box = headerButtonsRef.current;
        const row = transcriptHeaderRef.current;
        const title = row?.firstElementChild as HTMLElement | null;
        if (!box || !row || !title) return;
        // The buttons' box is only as wide as they are, so it can't say whether there's room to spare. The
        // room is what's left of the row after the title and the gap between them. Add up the buttons'
        // widths (they're right-aligned, so a squeeze spills out of the box's left edge, which scrollWidth
        // doesn't count) and step down while that plus some breathing room doesn't fit.
        const kids = Array.from(box.children) as HTMLElement[];
        const boxGap = parseFloat(getComputedStyle(box).columnGap) || 0;
        const rowGap = parseFloat(getComputedStyle(row).columnGap) || 0;
        const needed = kids.reduce((sum, k) => sum + k.offsetWidth, 0) + boxGap * Math.max(0, kids.length - 1);
        const available = row.clientWidth - title.offsetWidth - rowGap;
        if (needed + HEADER_BUTTONS_SLACK > available) {
            setHeaderActionMode(m => (m === 'full' ? 'short' : m === 'short' ? 'icon' : m));
        }
    });
    // Esc closes the Find & Replace or Detect Glossary box that's open, rather than reaching App's Esc,
    // which would close this whole panel. Listened for in the capture phase, ahead of that handler.
    useEffect(() => {
        if (!showFindReplace && !showGlossaryDetect && !showReadFind) return;
        const onKey = (e: KeyboardEvent) => {
            // A definition opened from the Detect panel is a dialog on top: Esc closes that first.
            if (e.key !== 'Escape' || e.defaultPrevented || selectedTerm) return;
            e.preventDefault();
            e.stopPropagation();
            if (showGlossaryDetect) setShowGlossaryDetect(false);
            else if (showFindReplace) setShowFindReplace(false);
            else setShowReadFind(false);
            // Focus goes back to the editor. Left on the button that opened the box, the Esc keypress
            // would make the browser draw its keyboard-focus highlight around that button.
            (document.activeElement as HTMLElement | null)?.blur?.();
            (isEditingTranscript ? transcriptEditRef : summaryEditRef).current?.focus();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [showFindReplace, showGlossaryDetect, showReadFind, setShowFindReplace, isEditingTranscript, selectedTerm]);
    const activeEditor = () => (isEditingTranscript ? transcriptEditRef : summaryEditRef).current;
    const applyGlossaryLinks = (newText: string) => {
        const textarea = activeEditor();
        if (textarea) {
            // Through the editor's own undo history, like Replace All. Replacing everything sends the view
            // to the caret, so the scroll spot (and where the caret was) is put back: the text stays
            // where it is, for the change to be seen happening in place.
            const { scrollTop, scrollLeft, selectionStart } = textarea;
            const backdrop = (isEditingTranscript ? transcriptBackdropRef : summaryBackdropRef).current;
            const restore = () => {
                textarea.scrollTop = scrollTop;
                textarea.scrollLeft = scrollLeft;
                if (backdrop) { backdrop.scrollTop = scrollTop; backdrop.scrollLeft = scrollLeft; }
            };
            textarea.focus({ preventScroll: true });
            textarea.select();
            document.execCommand('insertText', false, newText);
            const caret = Math.min(selectionStart, newText.length);
            textarea.setSelectionRange(caret, caret);
            restore();
            // Again once the editor has re-rendered with the new text.
            requestAnimationFrame(restore);
        } else if (isEditingTranscript) {
            setEditedTranscript(newText);
        } else {
            setEditedSummary(newText);
        }
    };
    const showInEditor = (start: number, end: number) => {
        const textarea = activeEditor();
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(start, end);
        const full = isEditingTranscript ? editedTranscript : editedSummary;
        const line = full.slice(0, start).split('\n').length;
        textarea.scrollTop = (line / full.split('\n').length) * textarea.scrollHeight - textarea.clientHeight / 2;
        const backdrop = (isEditingTranscript ? transcriptBackdropRef : summaryBackdropRef).current;
        if (backdrop) backdrop.scrollTop = textarea.scrollTop;
    };

    // Preview and editor keep their place: the preview opens at the text the caret was in, and going back
    // puts the editor where the preview had scrolled to (see lib/preview-sync.ts). Left alone in the
    // preview, going back restores the caret and scroll exactly as they were.
    const [isPreviewingTranscript, setIsPreviewingTranscript] = useState(false);
    const [isPreviewingSummary, setIsPreviewingSummary] = useState(false);
    const previewScrollRef = useRef<HTMLDivElement>(null);
    const previewMemo = useRef<{ caret: number; editorScroll: number; previewScroll: number } | null>(null);
    const previewToShow = useRef<{ line: number; fraction: number } | null>(null);
    const editorSpot = useRef<{ index: number; scrollTop?: number; offset?: number } | null>(null);
    const togglePreview = (kind: 'transcript' | 'summary') => {
        const transcriptKind = kind === 'transcript';
        const previewing = transcriptKind ? isPreviewingTranscript : isPreviewingSummary;
        const text = transcriptKind ? editedTranscript : editedSummary;
        if (!previewing) {
            const textarea = (transcriptKind ? transcriptEditRef : summaryEditRef).current;
            const caret = textarea?.selectionStart ?? 0;
            previewMemo.current = { caret, editorScroll: textarea?.scrollTop ?? 0, previewScroll: -1 };
            previewToShow.current = { line: lineAt(text, caret), fraction: text.length ? caret / text.length : 0 };
        } else {
            const pane = previewScrollRef.current;
            const memo = previewMemo.current;
            const top = pane ? topVisibleLine(pane) : null;
            if (pane && memo && memo.previewScroll >= 0 && Math.abs(pane.scrollTop - memo.previewScroll) < 2) {
                editorSpot.current = { index: memo.caret, scrollTop: memo.editorScroll };
            } else if (top) {
                editorSpot.current = { index: indexOfLine(text, top.line), offset: top.offset };
            } else if (pane && pane.scrollHeight > 0) {
                // A plain-text preview has no blocks to read a line from: go by how far through it is.
                const fraction = (pane.scrollTop + pane.clientHeight * 0.3) / pane.scrollHeight;
                editorSpot.current = { index: Math.round(text.length * Math.min(1, fraction)), offset: pane.clientHeight * 0.3 };
            }
        }
        (transcriptKind ? setIsPreviewingTranscript : setIsPreviewingSummary)(!previewing);
    };
    useLayoutEffect(() => {
        const pane = previewScrollRef.current;
        if (previewToShow.current !== null && pane) {
            scrollPreviewToLine(pane, previewToShow.current.line, 0.3, previewToShow.current.fraction);
            if (previewMemo.current) previewMemo.current.previewScroll = pane.scrollTop;
            previewToShow.current = null;
        } else if (editorSpot.current) {
            const spot = editorSpot.current;
            editorSpot.current = null;
            const textarea = activeEditor();
            if (!textarea) return;
            textarea.focus({ preventScroll: true });
            textarea.setSelectionRange(spot.index, spot.index);
            textarea.scrollTop = spot.scrollTop ?? Math.max(0, caretY(textarea, spot.index) - (spot.offset ?? 0));
            const backdrop = (isEditingTranscript ? transcriptBackdropRef : summaryBackdropRef).current;
            if (backdrop) backdrop.scrollTop = textarea.scrollTop;
        }
    }, [isPreviewingTranscript, isPreviewingSummary]);

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

    // Load the last-saved split ratio once on mount (the sidebar stays mounted while hidden, so
    // this doesn't need to re-run on `isOpen`). Ignore anything that fails to parse into the same
    // 30-85 range the drag handler itself enforces, so a corrupt/edited setting value can't wedge
    // the panel into a degenerate layout.
    useEffect(() => {
        getSetting(SPLIT_PERCENT_SETTING_KEY).then(value => {
            const parsed = value ? parseFloat(value) : NaN;
            if (!isNaN(parsed) && parsed > 30 && parsed < 85) {
                setSplitPercent(parsed);
            }
        }).catch(() => {});
    }, []);

    useEffect(() => {
        splitPercentRef.current = splitPercent;
    }, [splitPercent]);

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
        setSetting(SPLIT_PERCENT_SETTING_KEY, String(splitPercentRef.current)).catch(() => {});
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
        // The transcript side's width is what the divider sets; as a share of the base width it's what's kept.
        const base = Math.min(rect.width, SIDEBAR_BASE_WIDTH);
        const transcriptPx = rect.right - e.clientX;
        setSplitPercent(clampSplit(100 - (transcriptPx / base) * 100, base));
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
            if (existsInDb) {
                await saveTranscript(videoId, editedTranscript);
                setIsEditingTranscript(false);
                if (onRefetch) onRefetch();
            } else {
                // Not in the library yet, so there's nothing to update there: the text becomes this video's
                // transcript in the app (re-fetching would just fetch from YouTube again and lose it), and
                // Save then puts it in the library like any fetched transcript.
                onTranscriptChange?.(editedTranscript);
                setIsEditingTranscript(false);
            }
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

            getGlossaryTerms().then(setGlossaryTerms).catch(console.error);
        } else {
            document.body.style.overflow = 'auto';
        }
        return () => {
            document.body.style.overflow = 'auto';
        };
    }, [isOpen]);

    // The top-level Drives this video is in (its own plus any "Also in" ones), e.g. ":UAP". Terms
    // filed under one of them are offered first when adding a term (see VideoTagsPanel).
    const videoDriveRoots = useMemo(() => {
        const roots = new Set<string>();
        for (const p of [primaryWdbs, ...wdbsLinks]) {
            const display = decodeWdbs(p);
            if (display) roots.add(':' + display.slice(1).split('-')[0]);
        }
        return [...roots];
    }, [primaryWdbs, wdbsLinks]);
    const driveTerms = useMemo(() => {
        const rootsLower = new Set(videoDriveRoots.map(r => r.toLowerCase()));
        return new Set(glossaryTerms.filter(t => t.drives.some(d => rootsLower.has(d.toLowerCase()))).map(t => t.term));
    }, [videoDriveRoots, glossaryTerms]);

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
            onRefetch?.();
        } catch (err) {
            setSummaryError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoadingSummary(false);
        }
    }, [transcript, showSummary, hasExistingSummary, summary, videoId, onSummaryGenerated, onCacheSummary, onRefetch, handle]);

    const handleBackToTranscript = useCallback(() => {
        setShowSummary(false);
        setIsEditingSummary(false);
        setIsEditingTranscript(false);
    }, []);

    // Error sentinels are always short, app-generated strings (see App.tsx), so gate the
    // substring match on length too — otherwise a real transcript that happens to mention
    // "No transcript" in its actual spoken content would false-positive here.
    // Which side the Action Bar's copy button acts on: whatever's actually being read right now,
    // not always the transcript — see that button below for why this replaced the summary view's
    // own separate "Copy Summary" link (they used to disagree about which one you'd get).
    const viewingSummary = showSummary && !!summary;
    const isTranscriptInvalid = !transcript ||
        // The message App shows when the fetch failed always starts like this, however long the reason.
        transcript.startsWith("Failed to load transcript:") ||
        (transcript.length < 150 && (
            transcript.includes("No transcript") ||
            transcript.includes("Failed to load") ||
            transcript.includes("Could not load")
        ));

    // "N/A" is the placeholder left behind once a video's real transcript has been cleared in
    // favor of its AI summary (see the auto-switch effect above and clear_transcript_after_summary
    // server-side) — with allowEditTranscriptOnNA disabled, editing that placeholder is misleading
    // since the summary is the source of truth, so hide the pencil in exactly that case.
    const hideTranscriptEditButton = allowEditTranscriptOnNA === false &&
        transcript?.trim() === "N/A" && hasExistingSummary;

    // "Also in" (symlinks) only makes sense once there's a canonical WDBS to be "also" alongside
    // — see the "Also in" section below, and update_wdbs's own symlink cleanup when this becomes
    // false (clearing the canonical value removes any symlinks server-side too).
    const hasPrimaryWdbs = !!decodeWdbs(primaryWdbs);

    // Autocomplete suggestions (existing Warp Drive paths) are shared by the primary editor and
    // the "link to another Warp Drive" adder below — loaded once, not per-video.
    useEffect(() => {
        getWdbsSuggestions().then(paths => setWdbsSuggestions(paths.map(decodeWdbs).filter(Boolean))).catch(() => {});
    }, []);

    // Suggested Drives for the combobox above — every Drive this handle's other saved videos
    // already appear in (see the Suggested/Auto-Complete design this replaced the plain datalist
    // for). Depends only on the channel, so it's kept separate from the per-video reset effect below.
    useEffect(() => {
        if (!handle) { setChannelSuggestedDrives([]); return; }
        let cancelled = false;
        getHandleDrives(handle).then(drives => {
            if (!cancelled) setChannelSuggestedDrives(drives.map(d => d.display));
        }).catch(() => { if (!cancelled) setChannelSuggestedDrives([]); });
        return () => { cancelled = true; };
    }, [handle]);

    // Reset any in-progress WDBS edit whenever a different video is opened, so leftover input/
    // error state from one video's edit doesn't leak into the next one's panel. Symlinked Warp
    // Drives are re-fetched per video too, since they aren't part of the Video object itself.
    useEffect(() => {
        setIsEditingWdbs(false);
        setWdbsError(null);
        setIsAddingLink(false);
        setLinkInput('');
        setLinkError(null);
        setPrimaryWdbs(wdbs);
        setWdbsInput(decodeWdbs(wdbs));
        setLeftTab('terms');
        setSimilarVideos([]);
        fetchedSimilarForRef.current = null;
        setAttachmentCount(0);
        if (videoId && existsInDb && flags.showAttachments) {
            getVideoAttachments(videoId).then(data => setAttachmentCount(data.attachments.length)).catch(() => {});
        }
        if (videoId && existsInDb) {
            getVideoWdbsLinks(videoId).then(setWdbsLinks).catch(() => setWdbsLinks([]));
            // The `wdbs` prop is only ever populated for a video opened from Library/Portal, whose
            // Video object comes straight from the database. One opened from Search comes fresh
            // from the YouTube API and never carries a `wdbs` value, even when that same video is
            // already saved locally with one — so once we know it's in the db, look up the real
            // value directly rather than keep showing "N/A" (see api.ts's getVideoWdbs).
            getVideoWdbs(videoId).then(v => {
                setPrimaryWdbs(v ?? undefined);
                setWdbsInput(decodeWdbs(v));
            }).catch(() => {});
        } else {
            setWdbsLinks([]);
        }
    }, [videoId, wdbs, existsInDb, flags.showAttachments]);

    useEffect(() => {
        const paths = [primaryWdbs, ...wdbsLinks].filter((p): p is string => !!p && !!decodeWdbs(p));
        if (!existsInDb || paths.length === 0) {
            setWdbsAliases({});
            return;
        }
        let cancelled = false;
        getWdbsAliases(paths)
            .then(a => { if (!cancelled) setWdbsAliases(a); })
            .catch(() => { if (!cancelled) setWdbsAliases({}); });
        return () => { cancelled = true; };
    }, [existsInDb, primaryWdbs, wdbsLinks]);

    // Lazily loads similar videos only once the user actually switches to that tab (not
    // prefetched for every opened video) — reset (both the list and this ref) whenever videoId
    // changes, so switching back to this tab on a new video re-fetches instead of showing stale
    // results. Tracked via a ref rather than `similarVideos.length > 0` — a video can legitimately
    // have zero similar videos, and guarding on the result length instead of "have we fetched yet"
    // meant that case reran the fetch forever (every resolve set loading back to false, which made
    // the effect's own dependency change and fire again), flickering between the loading and empty
    // states.
    useEffect(() => {
        if (leftTab !== 'similar' || !videoId || fetchedSimilarForRef.current === videoId) return;
        fetchedSimilarForRef.current = videoId;
        setLoadingSimilar(true);
        getSimilarVideos(videoId).then(setSimilarVideos).catch(() => setSimilarVideos([])).finally(() => setLoadingSimilar(false));
    }, [leftTab, videoId]);

    const handleSaveWdbs = useCallback(async () => {
        if (!videoId) return;
        setSavingWdbs(true);
        setWdbsError(null);
        try {
            await updateVideoWdbs(videoId, wdbsInput.trim());
            setIsEditingWdbs(false);
            const encoded = encodeWdbs(wdbsInput);
            setPrimaryWdbs(encoded);
            onWdbsUpdated?.(encoded);
            onWdbsChanged?.();
        } catch (e: any) {
            // update_wdbs already turns a SQLite trigger rejection into a plain-language message
            // (see commands::wdbs::update_wdbs) — surface it as-is.
            setWdbsError(typeof e === "string" ? e : e?.message ?? `Failed to update ${labels.aliasDriveLink}.`);
        } finally {
            setSavingWdbs(false);
        }
    }, [videoId, wdbsInput, onWdbsUpdated, onWdbsChanged]);

    const handleAddLink = useCallback(async () => {
        if (!videoId || !linkInput.trim()) return;
        setSavingLink(true);
        setLinkError(null);
        try {
            const encoded = await addVideoWdbsLink(videoId, linkInput.trim());
            setWdbsLinks(prev => prev.includes(encoded) ? prev : [...prev, encoded]);
            setLinkInput('');
            setIsAddingLink(false);
            onWdbsChanged?.();
        } catch (e: any) {
            setLinkError(typeof e === "string" ? e : e?.message ?? `Failed to ${labels.aliasDriveSymlink.toLowerCase()} ${labels.aliasDriveLink}.`);
        } finally {
            setSavingLink(false);
        }
    }, [videoId, linkInput, onWdbsChanged]);

    const handleRemoveLink = useCallback(async (encoded: string) => {
        if (!videoId) return;
        // Optimistic: symlinks are low-stakes bookkeeping, and waiting on the round trip before
        // updating the chip list would make removal feel laggy for no real benefit.
        setWdbsLinks(prev => prev.filter(l => l !== encoded));
        try {
            await removeVideoWdbsLink(videoId, encoded);
            onWdbsChanged?.();
        } catch {
            setWdbsLinks(prev => prev.includes(encoded) ? prev : [...prev, encoded]);
        }
    }, [videoId, onWdbsChanged]);

    // What the pencil in the sequence bar opens: the video's home Drive and its "Also in" links (the
    // "Also in" links let it additionally show up under other Drives (see components/WdbsTreePanel.tsx)
    // without touching its home). Viewing and choosing between them is the bar's Drive dropdown.
    //
    // Styled to match the Glossary's Add Term modal (labeled fields, rounded-xl bg-[#121212] inputs,
    // px-4 py-3 text-sm) rather than the compact popover this used to be — it lives in a full modal
    // now (SequenceDock.tsx), so it should read like one, not like a cramped anchored dropdown.
    const driveFieldClass = "flex-1 min-w-0 bg-[#121212] border border-[#333] text-white rounded-xl px-4 py-3 text-sm font-mono focus:outline-none focus:border-red-600 transition-all placeholder-gray-600 disabled:opacity-50";
    const driveIconButtonClass = "p-2.5 rounded-lg hover:bg-[#272727] transition-colors cursor-pointer disabled:opacity-50 shrink-0";
    const driveActionButtonClass = "flex items-center gap-1.5 shrink-0 text-xs font-bold text-gray-300 hover:text-white bg-[#272727] hover:bg-[#3f3f3f] px-3 py-2.5 rounded-lg transition-colors cursor-pointer";
    const driveEditor = (
        <div className="space-y-6">
            <div>
                <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Primary {labels.aliasDriveLink}</label>
                {isEditingWdbs ? (
                    <div className="flex items-center gap-2">
                        <DriveComboBox
                            autoFocus
                            value={wdbsInput}
                            onValueChange={setWdbsInput}
                            suggestions={wdbsSuggestions}
                            suggestedDrives={channelSuggestedDrives}
                            onEnter={handleSaveWdbs}
                            onEscape={() => { setIsEditingWdbs(false); setWdbsInput(decodeWdbs(primaryWdbs)); setWdbsError(null); }}
                            placeholder=":CS-ML-REINF"
                            disabled={savingWdbs}
                            className={driveFieldClass}
                        />
                        <button onClick={handleSaveWdbs} disabled={savingWdbs} title="Save" className={`${driveIconButtonClass} text-green-500`}>
                            <Check className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => { setIsEditingWdbs(false); setWdbsInput(decodeWdbs(primaryWdbs)); setWdbsError(null); }}
                            disabled={savingWdbs}
                            title="Cancel"
                            className={`${driveIconButtonClass} text-gray-400 hover:text-white`}
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                ) : (
                    <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0 bg-[#121212] border border-[#333] rounded-xl px-4 py-3">
                            <span
                                className="block text-white font-mono text-sm truncate"
                                title={hasPrimaryWdbs ? (wdbsAliases[primaryWdbs!] ?? decodeWdbs(primaryWdbs)) : undefined}
                            >
                                {decodeWdbs(primaryWdbs) || "N/A"}
                            </span>
                        </div>
                        {allowEditWDBS && (
                            <button onClick={() => setIsEditingWdbs(true)} className={driveActionButtonClass}>
                                <Pencil className="w-3.5 h-3.5" /> Edit
                            </button>
                        )}
                    </div>
                )}
                {wdbsError && (
                    <div className="mt-2 text-xs text-red-400 bg-red-900/20 border border-red-500/30 rounded-lg px-3 py-2">
                        {wdbsError}
                    </div>
                )}
            </div>

            <div>
                <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Also In</label>
                {/* No links possible until a Primary Drive is set — explained rather than just left blank. */}
                {!hasPrimaryWdbs ? (
                    <p className="text-xs text-[#666666] italic">Set a Primary {labels.aliasDriveLink} first to link this video into others too.</p>
                ) : (
                    <div className="space-y-3">
                        {/* Compact chips — this is a list of what's already linked, not something that
                            needs the input fields' full size. */}
                        {(wdbsLinks.length > 0 || (allowEditWDBS && !isAddingLink)) && (
                            <div className="flex flex-wrap items-center gap-1.5">
                                {wdbsLinks.map(link => (
                                    <span
                                        key={link}
                                        className="flex items-center gap-1.5 bg-[#1a1a1a] border border-[#333] rounded-md pl-2.5 pr-1.5 py-1 text-xs text-white font-mono"
                                        title={wdbsAliases[link] ?? decodeWdbs(link)}
                                    >
                                        {decodeWdbs(link)}
                                        {allowEditWDBS && (
                                            <button
                                                onClick={() => handleRemoveLink(link)}
                                                title={`Remove ${labels.aliasDriveSymlink.toLowerCase()}`}
                                                className="text-gray-500 hover:text-red-400 transition-colors cursor-pointer"
                                            >
                                                <X className="w-3 h-3" />
                                            </button>
                                        )}
                                    </span>
                                ))}
                                {allowEditWDBS && !isAddingLink && (
                                    // Sized like the chips beside it (same padding/text size), not the bigger
                                    // field-row buttons — it's another item in this same list of tags.
                                    <button
                                        onClick={() => setIsAddingLink(true)}
                                        className="flex items-center gap-1 bg-[#1a1a1a] border border-[#333] hover:border-[#444] rounded-md pl-2 pr-2.5 py-1 text-xs text-gray-400 hover:text-white font-mono transition-colors cursor-pointer"
                                    >
                                        <Plus className="w-3 h-3" /> {labels.aliasDriveSymlink}
                                    </button>
                                )}
                            </div>
                        )}

                        {/* Its own full-width row, not squeezed in next to the chips: a Drive path can be
                            long, and typing it should stay readable rather than scrolling inside a narrow box. */}
                        {allowEditWDBS && isAddingLink && (
                            <div className="flex items-center gap-2">
                                <DriveComboBox
                                    autoFocus
                                    value={linkInput}
                                    onValueChange={setLinkInput}
                                    suggestions={wdbsSuggestions}
                                    suggestedDrives={channelSuggestedDrives}
                                    onEnter={handleAddLink}
                                    onEscape={() => { setIsAddingLink(false); setLinkInput(''); setLinkError(null); }}
                                    placeholder=":CS-ML-REINF"
                                    disabled={savingLink}
                                    className={driveFieldClass}
                                />
                                <button onClick={handleAddLink} disabled={savingLink || !linkInput.trim()} title={`Add ${labels.aliasDriveSymlink.toLowerCase()}`} className={`${driveIconButtonClass} text-green-500`}>
                                    <Check className="w-4 h-4" />
                                </button>
                                <button
                                    onClick={() => { setIsAddingLink(false); setLinkInput(''); setLinkError(null); }}
                                    disabled={savingLink}
                                    title="Cancel"
                                    className={`${driveIconButtonClass} text-gray-400 hover:text-white`}
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                        )}
                    </div>
                )}
                {linkError && (
                    <div className="mt-2 text-xs text-red-400 bg-red-900/20 border border-red-500/30 rounded-lg px-3 py-2">
                        {linkError}
                    </div>
                )}
            </div>
        </div>
    );

    // Ctrl+F. The browser's own find is always blocked (main.tsx), so this is the only search: with the
    // panel open on the transcript or AI summary being read, it opens the search-only box; while
    // editing, the full Find & Replace. It looks at nothing but that text.
    const editingText = isEditingTranscript || isEditingSummary;
    const readFind = useReadFind(showReadFind, showSummary && summary ? summary : transcript);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'f') return;
            if (!isOpen || selectedTerm || confirmEditTranscript || showPromptEditor) return;
            if (editingText) {
                setShowGlossaryDetect(false);
                setShowFindReplace(true);
            } else {
                setShowReadFind(true);
            }
            // Already open: jump back into its box with the text selected, like a browser's find.
            requestAnimationFrame(() => {
                const input = document.getElementById('sidebar-find-input') as HTMLInputElement | null;
                input?.focus();
                input?.select();
            });
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [isOpen, selectedTerm, confirmEditTranscript, showPromptEditor, editingText, setShowFindReplace]);
    // The two searches are for different views, and neither outlives its text.
    useEffect(() => {
        if (editingText || !isOpen || showPromptEditor) setShowReadFind(false);
        if (!editingText) setShowFindReplace(false);
    }, [editingText, isOpen, showPromptEditor, videoId, setShowFindReplace]);

    // Where the floating Find & Replace / Detect Glossary panels start: just below whatever heads the video
    // pane (the video player, or the Photosynthesis header with its Venice/Pixabay/Upload tabs), marked
    // data-panel-anchor, so they sit over the pane's content and not over that. Measured after each render.
    const contentRowRef = useRef<HTMLDivElement>(null);
    const [floatingPanelTop, setFloatingPanelTop] = useState(0);
    const floatingTopRef = useRef(0);
    // Only while a panel is open (that's the only time the number is used), and only when something that moves the
    // anchor changes or the row/anchor is resized. It doesn't run on every render, and only sets state when the
    // number really moves by a pixel, so a measurement can never feed back into another render forever.
    const floatingPanelOpen = showFindReplace || (showGlossaryDetect && editingText);
    useLayoutEffect(() => {
        const row = contentRowRef.current;
        if (!floatingPanelOpen || !row) return;
        const measure = () => {
            const anchor = row.querySelector('[data-panel-anchor]');
            const top = anchor ? Math.round(anchor.getBoundingClientRect().bottom - row.getBoundingClientRect().top) : 0;
            if (Math.abs(top - floatingTopRef.current) >= 1) {
                floatingTopRef.current = top;
                setFloatingPanelTop(top);
            }
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(row);
        const anchor = row.querySelector('[data-panel-anchor]');
        if (anchor) observer.observe(anchor);
        return () => observer.disconnect();
        // What decides which element is the anchor, and how big the pane is.
    }, [floatingPanelOpen, videoId, isOpen, showSummary, isEditingSummary, pluginPhotosynthesisEnabled, flags.showVideoPlayer, imageTab, effectiveSplit, sidebarWidth]);

    return (
        <>
            {isOpen && (
                <div
                    // The page's own dimming layer while the sidebar is open: it isn't a dialog, so back/forward still work.
                    data-nav-ok
                    className="fixed inset-0 bg-black/70 z-40 transition-opacity"
                    onClick={onClose}
                />
            )}

            <div
                id="sidebar-container"
                style={{ width: `max(min(${SIDEBAR_BASE_WIDTH}px, 100vw), calc(100vw - ${SIDEBAR_SIDE_GAP}px))` }}
                className={`fixed inset-y-0 right-0 bg-[#0f0f0f] border-l border-[#303030] transform transition-transform duration-300 ease-in-out z-50 ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
            >
                <div className="h-full flex flex-col">
                    <div className="px-4 py-2.5 border-b border-[#303030] flex justify-between items-start bg-white/5">
                        <div className="flex gap-3 items-start">
                            {videoId && (
                                <img
                                    src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`}
                                    alt={title || "Untitled"}
                                    className="w-[72px] h-10 shrink-0 object-cover rounded-md"
                                />
                            )}
                            <div className="flex flex-col gap-0.5 overflow-hidden">
                                <h2 className="text-sm font-semibold text-white pr-8 line-clamp-2 leading-snug">
                                    {title || "Untitled"}
                                </h2>
                                {handle && (
                                    <button
                                        onClick={showBiography ? () => onHandleClick?.(handle.startsWith('@') ? handle : `@${handle}`) : undefined}
                                        className={`text-xs text-[#aaaaaa] ${showBiography ? 'hover:text-red-400 cursor-pointer' : ''} text-left`}
                                        title={showBiography ? `View ${labels.aliasBiographyItem}` : undefined}
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

                    <div ref={contentRowRef} className="flex-1 flex overflow-hidden relative">
                        {/* Find & Replace and Detect Glossary float over the video side (top-right, against the divider), not the
                            transcript/summary being edited, so the text they act on stays in view. The wrapper is
                            the video pane's size below its header, and holds the scrim and the panels. */}
                        {(showFindReplace || (showGlossaryDetect && (isEditingTranscript || isEditingSummary))) && (
                            <div style={{ width: `${effectiveSplit}%`, top: floatingPanelTop }} className="absolute bottom-0 left-0 z-[51] pointer-events-none">
                                {/* Dims and blocks the tools underneath, so the panel reads as the thing to work in. It's
                                    inert on purpose (Esc or the panel's X closes it), and not a full-window overlay, so the
                                    text being edited beside it stays fully usable. */}
                                <div className="absolute inset-0 bg-black/60 pointer-events-auto animate-in fade-in duration-200" />
                                {/* Find & Replace Panel */}
                                {showFindReplace && (
                                    <FindReplacePanel
                                        findText={findText} setFindText={setFindText}
                                        replaceText={replaceText} setReplaceText={setReplaceText}
                                        matchCase={matchCase} setMatchCase={setMatchCase}
                                        matchWholeWord={matchWholeWord} setMatchWholeWord={setMatchWholeWord}
                                        matchCount={searchIndices.length} currentSearchIndex={currentSearchIndex}
                                        onClose={() => setShowFindReplace(false)}
                                        navigateMatch={navigateMatch}
                                        handleReplace={handleReplace}
                                        handleReplaceAll={handleReplaceAll}
                                    />
                                )}

                                {/* Detect Glossary Panel */}
                                {showGlossaryDetect && (isEditingTranscript || isEditingSummary) && (
                                    <GlossaryDetectPanel
                                        text={isEditingTranscript ? editedTranscript : editedSummary}
                                        glossaryTerms={glossaryTerms}
                                        driveRoots={videoDriveRoots}
                                        onApply={applyGlossaryLinks}
                                        onJump={showInEditor}
                                onOpenTerm={onSearchInLibrary ? setSelectedTerm : undefined}
                                        onClose={() => setShowGlossaryDetect(false)}
                                    />
                                )}
                            </div>
                        )}

                        {/* Left Side: Video Player or Image Tools */}
                        <div
                            style={{ width: `${effectiveSplit}%` }}
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
                                <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col custom-scrollbar">
                                    {videoId && isOpen ? (
                                        <>
                                            {flags.showVideoPlayer && (
                                            <div data-panel-anchor className={`aspect-video w-full bg-black rounded-lg overflow-hidden border border-gray-800 relative group ${isResizing ? 'pointer-events-none' : ''}`}>
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
                                                {flags.showOpenInYouTube && (
                                                <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <button
                                                        onClick={() => openExternalUrl(`https://www.youtube.com/watch?v=${videoId}`)}
                                                        className="bg-black/80 hover:bg-black text-white px-3 py-1.5 rounded-md text-[10px] font-bold flex items-center gap-1.5 border border-white/10 cursor-pointer"
                                                    >
                                                        <ExternalLink className="w-3 h-3" />
                                                        Open in YouTube
                                                    </button>
                                                </div>
                                                )}
                                            </div>
                                            )}
                                            {/* With the player hidden the overlay button has nothing to sit on. */}
                                            {!flags.showVideoPlayer && flags.showOpenInYouTube && (
                                                <button
                                                    onClick={() => openExternalUrl(`https://www.youtube.com/watch?v=${videoId}`)}
                                                    className="self-start bg-[#272727] hover:bg-[#3f3f3f] text-white px-3 py-1.5 rounded-md text-[10px] font-bold flex items-center gap-1.5 border border-white/10 cursor-pointer"
                                                >
                                                    <ExternalLink className="w-3 h-3" />
                                                    Open in YouTube
                                                </button>
                                            )}

                                            {existsInDb && availableLeftTabs.length > 0 && (
                                                <div className="mt-6 p-4 bg-white/5 rounded-xl border border-white/5">
                                                    {/* No overflow-hidden here or on the row below: each label truncates to an
                                                        ellipsis on its own (min-w-0 + truncate), so the row itself never needs to
                                                        clip anything, and this card is free to grow to fit whatever tab is active
                                                        below (Terms/Tags/Similar/Attachments) and push the pane's own scroll. */}
                                                    <div className="flex items-center gap-4 mb-3">
                                                        {showTermsTab && (
                                                        <button
                                                            onClick={() => setLeftTab('terms')}
                                                            title="Terms"
                                                            className={`flex items-center gap-1.5 min-w-0 pb-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer relative ${activeLeftTab === 'terms' ? 'text-white' : 'text-[#666666] hover:text-[#aaaaaa]'}`}
                                                        >
                                                            <BookA className="w-3.5 h-3.5 shrink-0" />
                                                            <span className="truncate">Terms</span>
                                                            {activeLeftTab === 'terms' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                                                        </button>
                                                        )}
                                                        {showTagsTab && (
                                                        <button
                                                            onClick={() => setLeftTab('tags')}
                                                            title="Tags"
                                                            className={`flex items-center gap-1.5 min-w-0 pb-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer relative ${activeLeftTab === 'tags' ? 'text-white' : 'text-[#666666] hover:text-[#aaaaaa]'}`}
                                                        >
                                                            <Tags className="w-3.5 h-3.5 shrink-0" />
                                                            <span className="truncate">Tags</span>
                                                            {activeLeftTab === 'tags' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                                                        </button>
                                                        )}
                                                        {flags.showSimilarVideos && (
                                                        <button
                                                            onClick={() => setLeftTab('similar')}
                                                            title="Similar Videos"
                                                            className={`flex items-center gap-1.5 min-w-0 pb-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer relative ${activeLeftTab === 'similar' ? 'text-white' : 'text-[#666666] hover:text-[#aaaaaa]'}`}
                                                        >
                                                            <ListVideo className="w-3.5 h-3.5 shrink-0" />
                                                            <span className="truncate">Similar Videos</span>
                                                            {activeLeftTab === 'similar' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                                                        </button>
                                                        )}
                                                        {flags.showAttachments && (
                                                        <button
                                                            onClick={() => setLeftTab('attachments')}
                                                            title="Attachments"
                                                            className={`flex items-center gap-1.5 min-w-0 pb-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer relative ${activeLeftTab === 'attachments' ? 'text-white' : 'text-[#666666] hover:text-[#aaaaaa]'}`}
                                                        >
                                                            <Paperclip className="w-3.5 h-3.5 shrink-0" />
                                                            <span className="truncate">Attachments</span>
                                                            {attachmentCount > 0 && (
                                                                <span className="shrink-0 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-[#3f3f3f] text-white text-[9px] font-bold leading-none normal-case tracking-normal">
                                                                    {attachmentCount}
                                                                </span>
                                                            )}
                                                            {activeLeftTab === 'attachments' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                                                        </button>
                                                        )}
                                                    </div>
                                                    {activeLeftTab === 'terms' || activeLeftTab === 'tags' ? (
                                                        <VideoTagsPanel
                                                            kind={activeLeftTab}
                                                            videoTags={videoTags}
                                                            glossaryTerms={glossaryTerms}
                                                            preferredDrives={videoDriveRoots}
                                                            priorityTerms={activeLeftTab === 'terms' ? driveTerms : undefined}
                                                            priorityLabel={videoDriveRoots.join(', ')}
                                                            canEdit={flags.allowEditTermsAndTags}
                                                            onAddTag={onAddTag}
                                                            onRemoveTag={onRemoveTag}
                                                            onSelectTerm={setSelectedTerm}
                                                        />
                                                    ) : activeLeftTab === 'attachments' ? (
                                                        <AttachmentsPanel
                                                            key={videoId}
                                                            videoId={videoId}
                                                            canEdit={flags.editAttachments}
                                                            onCountChange={setAttachmentCount}
                                                        />
                                                    ) : (
                                                        <SimilarVideosPanel
                                                            videos={similarVideos}
                                                            loading={loadingSimilar}
                                                            onSelect={(video) => onVideoSelect?.(video)}
                                                        />
                                                    )}
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

                            {/* Pinned under the scrolling pane: the video's Drives and the First / Previous / Next of
                                the one being followed. Shown for any saved video, even one with no sequence yet. */}
                            {videoId && isOpen && existsInDb && flags.showDrive && !(pluginPhotosynthesisEnabled && showSummary && isEditingSummary) && (
                                <SequenceDock
                                    videoId={videoId}
                                    videoTitle={title}
                                    warp={primaryWdbs}
                                    wefts={wdbsLinks}
                                    aliases={wdbsAliases}
                                    showSequences={flags.showSequences}
                                    canEditSequences={flags.allowEditSequences}
                                    // Narrows canEditSequences further; never exceeds it (see SequenceDock's prop doc).
                                    canAddVideos={flags.allowEditSequences && flags.allowEditVideosInSequenceList}
                                    // Narrows allowEditWDBS further, the same way, so a DB owner who's opted into
                                    // WDBS editing can still hide just the pencil (and Bulk Assign Mode) with this.
                                    canEditDrives={allowEditWDBS && flags.allowEditDriveLinking}
                                    driveContext={driveContext ? decodeWdbs(driveContext).toUpperCase() || null : null}
                                    activeDrive={activeSeqDrive}
                                    setActiveDrive={setActiveSeqDrive}
                                    onOpenVideo={openSequenceVideo}
                                    onSelectDrive={onSelectDrive}
                                    driveEditor={driveEditor}
                                />
                            )}
                        </div>

                        {/* Draggable Divider */}
                        <div
                            onMouseDown={startResizing}
                            className={`absolute inset-y-0 w-1.5 cursor-col-resize z-10 transition-colors group ${isResizing ? 'bg-[#3f3f3f]' : 'hover:bg-[#272727]'}`}
                            style={{ left: `calc(${effectiveSplit}% - 3px)` }}
                        >
                            <div className="h-full w-px bg-[#303030] mx-auto" />
                        </div>

                        {/* Transcript Side */}
                        <div
                            style={{ width: `${100 - effectiveSplit}%` }}
                            className="p-4 text-[#aaaaaa] text-sm leading-relaxed font-sans selection:bg-[#3f3f3f] flex flex-col overflow-hidden"
                        >
                            {/* Read-only Ctrl+F: search only, in a row above the transcript / AI summary it searches. */}
                            {showReadFind && (
                                <div className="mb-3 shrink-0">
                                    <FindReplacePanel
                                        findOnly
                                        anchor="inline"
                                        findText={readFind.findText} setFindText={readFind.setFindText}
                                        replaceText="" setReplaceText={() => {}}
                                        matchCase={readFind.matchCase} setMatchCase={readFind.setMatchCase}
                                        matchWholeWord={readFind.matchWholeWord} setMatchWholeWord={readFind.setMatchWholeWord}
                                        matchCount={readFind.matchCount} currentSearchIndex={readFind.currentIndex}
                                        onClose={() => setShowReadFind(false)}
                                        navigateMatch={readFind.navigateMatch}
                                        handleReplace={() => {}}
                                        handleReplaceAll={() => {}}
                                    />
                                </div>
                            )}
                            <div className="flex-1 min-h-0 overflow-y-auto pr-2 custom-scrollbar flex flex-col">
                                {/* Header with Summarize button */}
                                <div ref={transcriptHeaderRef} className="flex justify-between items-center mb-4 gap-2">
                                    {/* min-w-0 + truncate rather than shrink-0: this is what frees the room that keeps the
                                        Edit pencil from landing behind the pane's own scrollbar once the row is tight,
                                        instead of the buttons to its right being the only thing that can give. */}
                                    <span className="shrink-0 truncate text-[10px] font-bold uppercase tracking-[0.2em] text-[#aaaaaa]" title={showSummary ? 'AI Summary' : undefined}>
                                        {showSummary ? (
                                            <>
                                                <Sparkles className="w-3 h-3 inline" /> AI Summary
                                            </>
                                        ) : (
                                            "Transcript"
                                        )}
                                    </span>
                                    <div ref={headerButtonsRef} className="flex items-center justify-end gap-2 min-w-0">
                                        {!showPromptEditor && (
                                            <>
                                                {showSummary ? (
                                                    (
                                                        <button
                                                            onClick={handleBackToTranscript}
                                                            title="Back to Transcript"
                                                            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#272727] text-[#aaaaaa] rounded-lg hover:text-white hover:bg-[#3f3f3f] transition-colors text-[10px] font-bold uppercase tracking-wider whitespace-nowrap cursor-pointer"
                                                        >
                                                            <ArrowLeft className="w-3 h-3" />
                                                            {headerActionMode === 'full' ? 'Back to Transcript' : headerActionMode === 'short' ? 'Back' : null}
                                                        </button>
                                                    )
                                                ) : (
                                                    !isEditingTranscript && !isEditingSummary && (pluginSummarizeEnabled || hasExistingSummary) && (
                                                        <button
                                                            onClick={handleSummarize}
                                                            disabled={loadingSummary || loading || isTranscriptInvalid || checkingSummary}
                                                            title={hasExistingSummary ? "View AI Summary from database" : `Generate AI summary with ${summarizeProvider === 'cloud' ? 'Venice' : 'Ollama'}`}
                                                            className="summarize-btn flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-lg hover:from-purple-500 hover:to-blue-500 transition-all text-[10px] font-bold uppercase tracking-wider whitespace-nowrap disabled:opacity-30 disabled:cursor-default cursor-pointer"
                                                        >
                                                            {checkingSummary ? (
                                                                <>
                                                                    <svg className="w-3 h-3 animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
                                                                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.2" />
                                                                        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                                                    </svg>
                                                                    {headerActionMode !== 'icon' && 'Checking...'}
                                                                </>
                                                            ) : loadingSummary ? (
                                                                <>
                                                                    <svg className="w-3 h-3 animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
                                                                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.2" />
                                                                        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                                                    </svg>
                                                                    {headerActionMode !== 'icon' && 'Generating...'}
                                                                </>
                                                            ) : (
                                                                <>
                                                                    <Sparkles className="w-3 h-3 shrink-0" />
                                                                    {headerActionMode !== 'icon' && (hasExistingSummary ? "AI Summary" : "Summarize")}
                                                                </>
                                                            )}
                                                        </button>
                                                    )
                                                )}
                                                {(isEditingTranscript || isEditingSummary) && (
                                                    <button
                                                        onClick={() => { setShowGlossaryDetect(false); setShowFindReplace(!showFindReplace); }}
                                                        title={showFindReplace ? 'Close Find' : 'Find & Replace'}
                                                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all text-[10px] font-bold uppercase tracking-wider whitespace-nowrap cursor-pointer ${showFindReplace ? 'bg-blue-600 text-white' : 'bg-[#272727] text-[#aaaaaa] hover:text-white hover:bg-[#3f3f3f]'}`}
                                                    >
                                                        <Search className="w-3 h-3 shrink-0" />
                                                        {headerActionMode === 'full' ? (showFindReplace ? 'Close Find' : 'Find & Replace') : headerActionMode === 'short' ? 'Find' : null}
                                                    </button>
                                                )}
                                                {(isEditingTranscript || isEditingSummary) && flags.showGlossary && (
                                                    <button
                                                        onClick={() => { setShowFindReplace(false); setShowGlossaryDetect(v => !v); }}
                                                        title={showGlossaryDetect ? 'Close Detect Glossary' : 'Suggest glossary terms to link'}
                                                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all text-[10px] font-bold uppercase tracking-wider whitespace-nowrap cursor-pointer ${showGlossaryDetect ? 'bg-blue-600 text-white' : 'bg-[#272727] text-[#aaaaaa] hover:text-white hover:bg-[#3f3f3f]'}`}
                                                    >
                                                        <BookA className="w-3 h-3 shrink-0" />
                                                        {headerActionMode === 'full' ? 'Detect Glossary' : headerActionMode === 'short' ? 'Detect' : null}
                                                    </button>
                                                )}
                                                {!showSummary && !isEditingTranscript && pluginPhotosynthesisEnabled && !hideTranscriptEditButton && flags.allowEditTranscript && (
                                                    <button
                                                        // With "clear the transcript after summarizing" on, time spent editing it is
                                                        // lost once a summary exists: say so first, so nobody sinks an hour into it.
                                                        onClick={() => (flags.setTranscriptAfterSummarizeToNA ? setConfirmEditTranscript(true) : startEditingTranscript())}
                                                        className="shrink-0 p-1.5 bg-[#272727] text-[#aaaaaa] rounded-lg hover:text-white hover:bg-[#3f3f3f] transition-colors cursor-pointer"
                                                        title="Edit Transcript"
                                                    >
                                                        <Pencil className="w-3 h-3" />
                                                    </button>
                                                )}
                                                {showSummary && !isEditingSummary && summary && pluginPhotosynthesisEnabled && flags.allowEditSummary && (
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
                                                             onContextMenu={handleMarkdownContextMenu}
                                                             onKeyDown={(e) => {
                                                                 handleMarkdownKeyDown(e, editedSummary, setEditedSummary);
                                                             }}
                                                              className="absolute inset-0 w-full h-full p-3 m-0 border-none bg-transparent text-white outline-none text-xs leading-relaxed resize-none font-mono selection:bg-purple-500/30"
                                                             spellCheck={false}
                                                         />
                                                     </div>
                                                     ) : (
                                                     <div className="flex-1 flex flex-col">
                                                         <div className="flex-1 relative rounded-lg border border-[#333] bg-black/20 overflow-hidden">
                                                             <div ref={previewScrollRef} className="absolute inset-0 p-3 overflow-y-auto custom-scrollbar whitespace-normal">
                                                                 <div className="leading-relaxed prose dark:prose-invert prose-sm max-w-none">
<ReactMarkdown
                                                                     remarkPlugins={[remarkGfm, remarkHighlight, remarkSourceLines]}
 urlTransform={markdownUrlTransform}
                                                                     components={{
                                                                         a: MarkdownLink,
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
                                                     </div>
                                                     )}
                                                       <div className="flex justify-between items-center p-2">
                                                           <div
                                                               onClick={() => togglePreview('summary')}
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
                                                    {/* No separate "Copy Summary" link here any more: the Action Bar's copy
                                                        button below already does this while the Summary is showing, so
                                                        there's one copy control per view, not two disagreeing ones. */}
                                                    <div data-find-scope className="leading-relaxed prose dark:prose-invert prose-sm max-w-none">
                                                        <ReactMarkdown
                                                            remarkPlugins={[remarkGfm, remarkHighlight]}
 urlTransform={markdownUrlTransform}
                                                            components={{
                                                                a: MarkdownLink,
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
                                            <div className="flex items-center gap-4">
                                                <button
                                                    onClick={() => setPromptTab('local')}
                                                    className={`flex items-center gap-1.5 pb-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer relative ${promptTab === 'local' ? 'text-white' : 'text-[#666666] hover:text-[#aaaaaa]'}`}
                                                >
                                                    <Monitor className="w-3.5 h-3.5" />
                                                    Local (Ollama)
                                                    {promptTab === 'local' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                                                </button>
                                                <button
                                                    onClick={() => setPromptTab('cloud')}
                                                    className={`flex items-center gap-1.5 pb-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer relative ${promptTab === 'cloud' ? 'text-white' : 'text-[#666666] hover:text-[#aaaaaa]'}`}
                                                >
                                                    <Cloud className="w-3.5 h-3.5" />
                                                    Cloud (Venice)
                                                    {promptTab === 'cloud' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
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
                                        <div className="flex flex-col justify-start items-center gap-3 h-40 pt-10">
                                            {/* The app's own Game of Life loader, with the panel's ordinary muted helper text. */}
                                            <LifeLoader cell={6} gap={2} />
                                            <p className="text-[11px] text-[#888888]">Loading transcript</p>
                                        </div>
                                    ) : (!isTranscriptInvalid || isEditingTranscript) ? (
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
                                                                onContextMenu={handleMarkdownContextMenu}
                                                                onKeyDown={(e) => {
                                                                    handleMarkdownKeyDown(e, editedTranscript, setEditedTranscript);
                                                                }}
                                                                className="absolute inset-0 w-full h-full p-3 m-0 border-none bg-transparent text-white outline-none text-xs leading-relaxed resize-none font-mono selection:bg-green-500/30"
                                                                spellCheck={false}
                                                                placeholder="Paste or type the transcript here (markdown supported)."
                                                            />
                                                        </div>
                                                    ) : (
                                                        <div className="flex-1 flex flex-col">
                                                            <div className="flex-1 relative rounded-lg border border-[#333] bg-black/20 overflow-hidden">
                                                                <div ref={previewScrollRef} className="absolute inset-0 p-3 overflow-y-auto custom-scrollbar whitespace-pre-wrap">
                                                                    <TranscriptText text={editedTranscript} sourceLines onImageClick={setFullscreenImage} />
                                                                </div>
                                                            </div>
                                                        </div>
                                                    )}
                                                    <div className="flex justify-between items-center p-2">
                                                        <div
                                                            onClick={() => togglePreview('transcript')}
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
                                                                disabled={isSaving || isPreviewingTranscript || (isTranscriptInvalid && !editedTranscript.trim())}
                                                                className="px-4 py-1.5 bg-green-600 text-white dark:text-white rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-green-500 transition-colors disabled:opacity-30 cursor-pointer"
                                                            >
                                                                {isSaving ? "Saving..." : "Save Changes"}
                                                            </button>
                                                        </div>
                                                    </div>
                                                </div>

                                            ) : (
                                                <div data-find-scope><TranscriptText text={transcript} onImageClick={setFullscreenImage} /></div>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="text-center mt-10 flex flex-col items-center gap-3">
                                            {/* The panel's ordinary muted helper text, not a shouted heading. */}
                                            <p className="text-[11px] text-[#888888] leading-relaxed max-w-xs">{transcript || "No transcript data available."}</p>
                                            <div className="flex items-center gap-2">
                                                {onRefetch && (
                                                    <button
                                                        onClick={onRefetch}
                                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-[#272727] text-[#aaaaaa] rounded-lg hover:text-white hover:bg-[#3f3f3f] transition-colors text-[10px] font-bold uppercase tracking-wider cursor-pointer"
                                                    >
                                                        <RotateCcw className="w-3 h-3" />
                                                        Try Again
                                                    </button>
                                                )}
                                                {/* Whatever the reason (no captions, blocked, private), the transcript can be pasted in by hand. */}
                                                {flags.allowEditTranscript && (
                                                    <button
                                                        onClick={() => {
                                                            setIsEditingSummary(false);
                                                            setEditedTranscript('');
                                                            setIsPreviewingTranscript(false);
                                                            setIsEditingTranscript(true);
                                                        }}
                                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-[#272727] text-[#aaaaaa] rounded-lg hover:text-white hover:bg-[#3f3f3f] transition-colors text-[10px] font-bold uppercase tracking-wider cursor-pointer"
                                                    >
                                                        <ClipboardPaste className="w-3 h-3" />
                                                        Paste Transcript
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                            
                            {/* Sticky Footer Area (Action Bar & Prompt) */}
                            {!isEditingTranscript && !isEditingSummary && (
                                <div className="mt-2 space-y-3 pt-3 border-t border-white/5">
                                     {/* Custom Prompt Editor */}
                                    {/* !flags.workspaceReadOnly: Read-only hides this outright rather than just disabling
                                        it — there's no view-only rendering of a custom prompt, showing it always means
                                        being able to edit it. showCustomPrompt itself isn't in READ_ONLY_OVERRIDE_KEYS
                                        (it already has its own dedicated toggle in PluginsTab; this checks it directly). */}
                                    {showCustomPrompt && !flags.workspaceReadOnly && pluginSummarizeEnabled && (
                                        <div className="p-3 bg-white/5 rounded-xl border border-white/5 relative z-20">
                                            <div className="flex items-center justify-between gap-2">
                                                {/* min-w-0 so the label (below) can actually shrink to an ellipsis instead of
                                                    pushing Show/Hide — an interactive control — off the edge or behind the
                                                    scrollbar. The hint icon keeps shrink-0: it's a fixed-size glyph, not text. */}
                                                <div className="flex items-center gap-2 min-w-0">
                                                    <span className="min-w-0 truncate text-[10px] font-bold uppercase tracking-[0.2em] text-[#888888]" title="Custom Prompt">Custom Prompt</span>
                                                    <div className="group/hint relative flex items-center shrink-0">
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
                                                        className="shrink-0 whitespace-nowrap text-[#666666] hover:text-white transition-colors cursor-pointer text-[9px] uppercase font-bold"
                                                    >
                                                        {showPromptEditor ? 'Hide' : 'Show'}
                                                    </button>
                                                ) : (
                                                    // Truncated rather than wrapped or shrunk-with-the-row: it's explanatory, not an
                                                    // action label, and its length varies with the workspace's Library alias — the
                                                    // "Custom Prompt" label to its left is the important, fixed-length part to protect.
                                                    <span className="min-w-0 truncate text-[9px] text-[#666666] uppercase font-bold" title={`Save to ${labels.aliasLibrary} to Edit`}>
                                                        (Save to {labels.aliasLibrary} to Edit)
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {/* Action Bar */}
                                    <div className="flex gap-2">
                                        {/* One copy button, following whichever side is actually showing (see
                                            viewingSummary) — not a fixed "Copy Transcript" regardless of view. */}
                                        <button
                                            onClick={viewingSummary ? handleCopySummary : handleCopy}
                                            disabled={viewingSummary ? false : (loading || isTranscriptInvalid)}
                                            title={viewingSummary ? "Copy AI Summary to clipboard" : "Copy Transcript to clipboard"}
                                            className={`flex-1 min-w-0 truncate px-2 py-1.5 rounded-lg border border-[#383838] bg-[#222222] text-white transition-all text-xs font-semibold disabled:opacity-20 ${!viewingSummary && (loading || isTranscriptInvalid) ? 'cursor-default' : 'hover:bg-[#3f3f3f] cursor-pointer'}`}
                                        >
                                            {(viewingSummary ? summaryCopied : copied) ? "Copied" : (viewingSummary ? "Copy Summary" : "Copy Transcript")}
                                        </button>

                                        {existsInDb && onDelete && allowDeletion ? (
                                            <button
                                                onClick={onDelete}
                                                disabled={loading || isTranscriptInvalid || checkingDb}
                                                title={isTranscriptInvalid ? "No transcript to delete" : `Delete from ${labels.aliasLibrary}`}
                                                className={`flex-1 min-w-0 py-1.5 rounded-lg bg-red-600 text-white transition-all text-xs font-bold disabled:opacity-20 flex items-center justify-center gap-2 ${loading || isTranscriptInvalid || checkingDb ? 'cursor-default' : 'hover:bg-red-500 cursor-pointer'}`}
                                            >
                                                <Trash2 className="w-3.5 h-3.5 shrink-0" />
                                                <span className="truncate">Delete</span>
                                            </button>
                                        ) : !existsInDb && flags.allowSaveToLibrary ? (
                                            <button
                                                onClick={handleOnSave}
                                                disabled={loading || isTranscriptInvalid || checkingDb}
                                                title={isTranscriptInvalid ? "No transcript to save" : `Save to ${labels.aliasLibrary}`}
                                                className={`flex-1 min-w-0 py-1.5 rounded-lg bg-red-600 text-white transition-all text-xs font-bold disabled:opacity-20 flex items-center justify-center gap-2 ${loading || isTranscriptInvalid || checkingDb ? 'cursor-default' : 'hover:bg-red-500 cursor-pointer'}`}
                                            >
                                                <Save className="w-3.5 h-3.5 shrink-0" />
                                                <span className="truncate">Save</span>
                                            </button>
                                        ) : null}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {confirmEditTranscript && (
                <ConfirmDialog
                    title="Edit transcript?"
                    message="Once an AI Summary is generated, this transcript is replaced with N/A and your edits are lost. Only edit it if you don't plan to summarize."
                    confirmLabel="Proceed"
                    onConfirm={() => { setConfirmEditTranscript(false); startEditingTranscript(); }}
                    onCancel={() => setConfirmEditTranscript(false)}
                />
            )}

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