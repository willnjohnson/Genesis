import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Download, ExternalLink, File, FileImage, FileSpreadsheet, FileText, Link2, Loader2, Paperclip, Plus, Trash2, X } from 'lucide-react';
import {
    addAttachmentLink, addAttachments, getAttachmentLink, getVideoAttachments, openAttachment, openExternalUrl,
    pickAttachmentFiles, removeAttachment, saveAttachmentAs, saveVideoNote, type AttachmentInfo,
} from '../../api';
import { ConfirmDialog } from '../ConfirmDialog';
import { useFlags } from '../../hooks/useFlags';

// Keep in step with MAX_ATTACHMENTS and MAX_LINKS in src-tauri/src/db/attachments.rs (the backend enforces them).
const MAX_ATTACHMENTS = 5;
const MAX_LINKS = 10;
// A link is an attachment of this type (see LINK_EXT in the same file).
const isLink = (a: AttachmentInfo) => a.ext === 'url';

interface Props {
    videoId: string;
    /** Whether the DB owner allows adding, removing and editing the note (`editAttachments`). */
    canEdit: boolean;
    /** Called whenever the attachment count changes, so the tab's badge stays in sync live. */
    onCountChange?: (count: number) => void;
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function FileIcon({ ext }: { ext: string }) {
    const cls = 'w-4 h-4 shrink-0 text-[#aaaaaa]';
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)) return <FileImage className={cls} />;
    if (['csv', 'xlsx'].includes(ext)) return <FileSpreadsheet className={cls} />;
    if (['pdf', 'txt', 'md', 'docx', 'pptx', 'html', 'json', 'xml'].includes(ext)) return <FileText className={cls} />;
    return <File className={cls} />;
}

/** The Sidebar's Attachments tab: a note explaining the attachments, then up to five files kept in
 *  the database with the video (see db/attachments.rs). Files are picked, read and stored by the
 *  backend, so their contents never pass through the webview. Opening one hands it to the system's
 *  default app; nothing (HTML and SVG included) is rendered inside Kinesis. */
export function AttachmentsPanel({ videoId, canEdit, onCountChange }: Props) {
    const { flags } = useFlags();
    const [note, setNote] = useState('');
    const [savedNote, setSavedNote] = useState('');
    const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [adding, setAdding] = useState(false);
    const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [errors, setErrors] = useState<string[]>([]);
    // The add-a-link form, and a link waiting on the user's OK before it's opened.
    const [addMenuOpen, setAddMenuOpen] = useState(false);
    const [showLinkForm, setShowLinkForm] = useState(false);
    const [linkTitle, setLinkTitle] = useState('');
    const [linkUrl, setLinkUrl] = useState('');
    const [linkError, setLinkError] = useState<string | null>(null);
    const [addingLink, setAddingLink] = useState(false);
    const [linkToOpen, setLinkToOpen] = useState<{ url: string; title: string } | null>(null);
    const [noteSaved, setNoteSaved] = useState(false);
    // Only shown as separate tabs once both kinds actually have something in them — otherwise
    // it's just one plain list, so a video with a couple of files and no links isn't cluttered
    // with a switcher that has nothing to switch to.
    const [attachTab, setAttachTab] = useState<'files' | 'links'>('files');
    const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const reload = useCallback(async () => {
        const data = await getVideoAttachments(videoId);
        setNote(data.note);
        setSavedNote(data.note);
        setAttachments(data.attachments);
    }, [videoId]);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setErrors([]);
        setConfirmRemoveId(null);
        getVideoAttachments(videoId)
            .then(data => {
                if (cancelled) return;
                setNote(data.note);
                setSavedNote(data.note);
                setAttachments(data.attachments);
            })
            .catch(e => { if (!cancelled) setErrors([typeof e === 'string' ? e : e?.message ?? 'Failed to load attachments.']); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [videoId]);

    useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

    // Skipped while `loading`: the initial empty array would otherwise briefly report 0 and flicker
    // the tab's badge down before the real count (already shown, fetched eagerly by Sidebar) loads.
    useEffect(() => {
        if (!loading) onCountChange?.(attachments.length);
    }, [attachments.length, loading, onCountChange]);

    const messageOf = (e: unknown, fallback: string) => (typeof e === 'string' ? e : (e as { message?: string })?.message ?? fallback);

    const saveNote = async () => {
        if (!canEdit || note === savedNote) return;
        try {
            await saveVideoNote(videoId, note);
            setSavedNote(note);
            setErrors([]);
            setNoteSaved(true);
            if (savedTimer.current) clearTimeout(savedTimer.current);
            savedTimer.current = setTimeout(() => setNoteSaved(false), 1500);
        } catch (e) {
            setErrors([messageOf(e, 'Failed to save the note.')]);
        }
    };

    const handleAdd = async () => {
        setErrors([]);
        setAdding(true);
        try {
            const paths = await pickAttachmentFiles();
            if (paths.length === 0) return;
            const outcomes = await addAttachments(videoId, paths);
            const failures = outcomes.filter(o => o.error).map(o => o.error as string);
            if (failures.length > 0) setErrors(failures);
            await reload();
        } catch (e) {
            setErrors([messageOf(e, 'Failed to add attachments.')]);
        } finally {
            setAdding(false);
        }
    };

    const handleRemove = async (id: number) => {
        setBusyId(id);
        try {
            await removeAttachment(id);
            setConfirmRemoveId(null);
            setErrors([]);
            await reload();
        } catch (e) {
            setErrors([messageOf(e, 'Failed to remove the attachment.')]);
        } finally {
            setBusyId(null);
        }
    };

    const handleOpen = async (id: number) => {
        setBusyId(id);
        try {
            await openAttachment(id);
            setErrors([]);
        } catch (e) {
            setErrors([messageOf(e, 'Failed to open the attachment.')]);
        } finally {
            setBusyId(null);
        }
    };

    const closeLinkForm = () => {
        setShowLinkForm(false);
        setLinkTitle('');
        setLinkUrl('');
        setLinkError(null);
    };

    const handleAddLink = async () => {
        if (!linkUrl.trim()) return;
        setLinkError(null);
        setAddingLink(true);
        try {
            await addAttachmentLink(videoId, linkTitle, linkUrl);
            closeLinkForm();
            setErrors([]);
            await reload();
        } catch (e) {
            // Shown in the form (a bad address is the usual reason), which stays open to be fixed.
            setLinkError(messageOf(e, 'Failed to add the URL.'));
        } finally {
            setAddingLink(false);
        }
    };

    // Reads the address (checked by the backend) and asks before leaving Kinesis. Nothing is opened
    // until the user confirms.
    const handleOpenLink = async (a: AttachmentInfo) => {
        setBusyId(a.id);
        try {
            const url = await getAttachmentLink(a.id);
            setLinkToOpen({ url, title: a.name });
            setErrors([]);
        } catch (e) {
            setErrors([messageOf(e, 'Failed to read the link.')]);
        } finally {
            setBusyId(null);
        }
    };

    const confirmOpenLink = () => {
        const link = linkToOpen;
        setLinkToOpen(null);
        // Web addresses only, even though the backend has already checked.
        if (!link || !/^https?:\/\//i.test(link.url)) return;
        openExternalUrl(link.url).catch(e => setErrors([messageOf(e, 'Failed to open the link.')]));
    };

    const handleSaveAs = async (id: number) => {
        setBusyId(id);
        try {
            await saveAttachmentAs(id);
            setErrors([]);
        } catch (e) {
            setErrors([messageOf(e, 'Failed to save the attachment.')]);
        } finally {
            setBusyId(null);
        }
    };

    if (loading) {
        return <p className="text-[11px] text-[#666666] italic py-2">Loading attachments...</p>;
    }

    // Files and links have their own limits, and (below) their own section of the list.
    const files = attachments.filter(a => !isLink(a));
    const links = attachments.filter(isLink);
    const fileCount = files.length;
    const linkCount = links.length;
    const atLimit = fileCount >= MAX_ATTACHMENTS;
    const linksAtLimit = linkCount >= MAX_LINKS;

    const renderRow = (a: AttachmentInfo) => (
        <li key={a.id} className="flex items-center gap-2 bg-[#1a1a1a] border border-[#333] rounded-lg px-2.5 py-1.5">
            {isLink(a) ? <Link2 className="w-4 h-4 shrink-0 text-blue-400" /> : <FileIcon ext={a.ext} />}
            <div className="min-w-0 flex-1">
                {/* A link shows the title it was given, never the address itself (that's shown, with a warning, when it's opened). */}
                <div className="text-xs text-white truncate" title={a.name}>{a.name}</div>
                <div className="text-[10px] text-[#777777]">{isLink(a) ? 'URL' : formatBytes(a.size)}</div>
            </div>
            {busyId === a.id ? (
                <Loader2 className="w-3.5 h-3.5 text-[#aaaaaa] animate-spin shrink-0" />
            ) : confirmRemoveId === a.id ? (
                <div className="flex items-center gap-1 shrink-0">
                    <span className="text-[10px] text-[#aaaaaa]">Remove?</span>
                    <button onClick={() => handleRemove(a.id)} title="Remove" className="text-red-500 hover:text-red-400 cursor-pointer p-1">
                        <Check className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setConfirmRemoveId(null)} title="Cancel" className="text-[#aaaaaa] hover:text-white cursor-pointer p-1">
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            ) : (
                <div className="flex items-center gap-0.5 shrink-0">
                    <button
                        onClick={() => (isLink(a) ? handleOpenLink(a) : handleOpen(a.id))}
                        title={isLink(a) ? 'Open Website' : 'Open'}
                        className="text-gray-500 hover:text-white transition-colors cursor-pointer p-1"
                    >
                        <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                    {!isLink(a) && (
                        <button onClick={() => handleSaveAs(a.id)} title="Save As" className="text-gray-500 hover:text-white transition-colors cursor-pointer p-1">
                            <Download className="w-3.5 h-3.5" />
                        </button>
                    )}
                    {canEdit && (
                        <button onClick={() => (flags.confirmBeforeDeleting ? setConfirmRemoveId(a.id) : void handleRemove(a.id))} title="Remove" className="text-gray-500 hover:text-red-400 transition-colors cursor-pointer p-1">
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
            )}
        </li>
    );

    return (
        <div className="space-y-3">
            <div>
                {canEdit ? (
                    <>
                        <textarea
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            onBlur={saveNote}
                            rows={3}
                            placeholder="Add a note about these attachments"
                            className="w-full bg-[#1a1a1a] border border-[#333] focus:border-red-600/50 outline-none rounded-lg px-3 py-2 text-xs text-white placeholder-[#555] resize-y transition-colors"
                        />
                        <div className="h-4 text-[10px] text-green-500 flex items-center gap-1">
                            {noteSaved && (<><Check className="w-3 h-3" />Saved</>)}
                        </div>
                    </>
                ) : note ? (
                    <p className="text-xs text-[#cccccc] whitespace-pre-wrap leading-relaxed">{note}</p>
                ) : (
                    <p className="text-[11px] text-[#666666] italic">No note.</p>
                )}
            </div>

            {attachments.length === 0 ? (
                <p className="text-[11px] text-[#666666] italic">No attachments or links.</p>
            ) : files.length > 0 && links.length > 0 ? (
                // Both kinds present: tabbed, so 5 files and 10 links don't add up to one long
                // scroll — only whichever list is showing counts toward the panel's height.
                <div>
                    <div className="flex items-center gap-1.5 mb-2">
                        {([['files', Paperclip, files.length], ['links', Link2, links.length]] as const).map(([tab, Icon, count]) => (
                            <button
                                key={tab}
                                onClick={() => setAttachTab(tab)}
                                className={`flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-1 rounded-full transition-colors cursor-pointer ${attachTab === tab ? 'bg-[#3f3f3f] text-white' : 'text-[#888888] hover:text-white hover:bg-[#272727]'}`}
                            >
                                <Icon className="w-3 h-3" />
                                {tab === 'files' ? 'Files' : 'Links'} ({count})
                            </button>
                        ))}
                    </div>
                    <ul className="space-y-1.5 max-h-64 overflow-y-auto custom-scrollbar pr-1">{(attachTab === 'files' ? files : links).map(renderRow)}</ul>
                </div>
            ) : (
                <ul className="space-y-1.5 max-h-64 overflow-y-auto custom-scrollbar pr-1">{(files.length > 0 ? files : links).map(renderRow)}</ul>
            )}

            {canEdit && (
                // One Add button; its menu offers the two kinds and shows how many of each are used,
                // since files and URLs have separate limits.
                <div className="relative inline-block">
                    <button
                        onClick={() => setAddMenuOpen(o => !o)}
                        disabled={adding || (atLimit && linksAtLimit)}
                        className="flex items-center gap-1.5 text-[11px] font-bold text-gray-300 hover:text-white bg-[#272727] hover:bg-[#3f3f3f] px-3 py-1.5 rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                        {adding ? 'Adding' : 'Add'}
                        <ChevronDown className="w-3 h-3" />
                    </button>
                    {addMenuOpen && (
                        <>
                            <div className="fixed inset-0 z-10" onClick={() => setAddMenuOpen(false)} />
                            <div className="absolute left-0 bottom-full mb-1 w-52 bg-[#1a1a1a] border border-[#383838] rounded-lg z-20 p-1">
                                <button
                                    onClick={() => { setAddMenuOpen(false); setShowLinkForm(false); handleAdd(); }}
                                    disabled={atLimit}
                                    title={atLimit ? `A video can have at most ${MAX_ATTACHMENTS} attachments` : undefined}
                                    className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded text-left text-[11px] text-white hover:bg-[#2a2a2a] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                                >
                                    <span className="flex items-center gap-2"><Paperclip className="w-3.5 h-3.5" />Attachment</span>
                                    <span className="text-[10px] text-[#888888]">{fileCount} of {MAX_ATTACHMENTS}</span>
                                </button>
                                <button
                                    onClick={() => { setAddMenuOpen(false); setShowLinkForm(true); }}
                                    disabled={linksAtLimit}
                                    title={linksAtLimit ? `A video can have at most ${MAX_LINKS} URLs` : undefined}
                                    className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded text-left text-[11px] text-white hover:bg-[#2a2a2a] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                                >
                                    <span className="flex items-center gap-2"><Link2 className="w-3.5 h-3.5" />URL</span>
                                    <span className="text-[10px] text-[#888888]">{linkCount} of {MAX_LINKS}</span>
                                </button>
                            </div>
                        </>
                    )}
                </div>
            )}

            {canEdit && showLinkForm && createPortal(
                // A modal, like the Glossary's Add Term: the pane is narrow, and this keeps the list from jumping.
                // Rendered on the page itself: the video panel slides in with a CSS transform, so a "fixed"
                // element inside it would position against the panel, and focusing its first field scrolled
                // the panel's contents.
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 animate-in fade-in duration-200"
                    onClick={() => { if (!addingLink) closeLinkForm(); }}
                    onKeyDown={e => { if (e.key === 'Escape' && !addingLink) closeLinkForm(); }}
                >
                    <form
                        onSubmit={e => { e.preventDefault(); handleAddLink(); }}
                        onClick={e => e.stopPropagation()}
                        className="bg-[#0f0f0f] border border-[#303030] rounded-2xl w-full max-w-md flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
                    >
                        <div className="px-6 py-4 border-b border-[#303030] flex items-center justify-between bg-[#141414]">
                            <div className="flex items-center gap-2 text-gray-200">
                                <Link2 className="w-4 h-4" />
                                <h2 className="text-lg font-bold">Add URL</h2>
                            </div>
                            <button type="button" onClick={closeLinkForm} disabled={addingLink} className="text-gray-500 hover:text-white transition-colors cursor-pointer">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="p-6 space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Title</label>
                                <input
                                    autoFocus
                                    value={linkTitle}
                                    onChange={e => setLinkTitle(e.target.value)}
                                    maxLength={200}
                                    placeholder="What shows in the list"
                                    className="w-full bg-[#1a1a1a] border border-[#333] focus:border-red-600/50 outline-none rounded-lg px-3 py-2 text-sm text-white placeholder-[#555]"
                                />
                                <p className="text-[10px] text-[#666666] mt-1.5">Leave blank to use the website's name.</p>
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Web Address</label>
                                <input
                                    value={linkUrl}
                                    onChange={e => setLinkUrl(e.target.value)}
                                    placeholder="https://example.com"
                                    spellCheck={false}
                                    className="w-full bg-[#1a1a1a] border border-[#333] focus:border-red-600/50 outline-none rounded-lg px-3 py-2 text-sm text-white placeholder-[#555] font-mono"
                                />
                            </div>
                            {linkError && (
                                <div className="text-xs text-red-400 bg-red-900/20 border border-red-500/30 rounded-md px-3 py-2">{linkError}</div>
                            )}
                        </div>
                        <div className="px-6 py-4 border-t border-[#303030] flex justify-end gap-3 bg-[#141414]">
                            <button
                                type="button"
                                onClick={closeLinkForm}
                                disabled={addingLink}
                                className="px-4 py-2 rounded-lg bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] cursor-pointer text-white text-sm font-semibold transition-colors disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={addingLink || !linkUrl.trim()}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 cursor-pointer text-white text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {addingLink && <Loader2 className="w-4 h-4 animate-spin" />}
                                {addingLink ? 'Adding' : 'Add URL'}
                            </button>
                        </div>
                    </form>
                </div>,
                document.body,
            )}

            {linkToOpen && (
                <ConfirmDialog
                    title="Open External Website"
                    confirmLabel="Open Website"
                    message={`"${linkToOpen.title}" is a link to an external website. Kinesis will open it in your web browser:\n\n${linkToOpen.url}\n\nOnly continue if you trust this website.`}
                    onCancel={() => setLinkToOpen(null)}
                    onConfirm={confirmOpenLink}
                />
            )}

            {errors.length > 0 && (
                <div className="text-[10px] text-red-400 bg-red-900/20 border border-red-500/30 rounded-md px-2 py-1.5 space-y-0.5">
                    {errors.map((e, i) => <div key={i}>{e}</div>)}
                </div>
            )}
        </div>
    );
}
