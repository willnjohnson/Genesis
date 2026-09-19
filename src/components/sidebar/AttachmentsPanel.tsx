import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Download, ExternalLink, File, FileImage, FileSpreadsheet, FileText, Loader2, Paperclip, Plus, Trash2, X } from 'lucide-react';
import {
    addAttachments, getVideoAttachments, openAttachment, pickAttachmentFiles, removeAttachment,
    saveAttachmentAs, saveVideoNote, type AttachmentInfo,
} from '../../api';

// Keep in step with MAX_ATTACHMENTS in src-tauri/src/db/attachments.rs (the backend enforces it).
const MAX_ATTACHMENTS = 5;

interface Props {
    videoId: string;
    /** Whether the DB owner allows adding, removing and editing the note (`editAttachments`). */
    canEdit: boolean;
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
export function AttachmentsPanel({ videoId, canEdit }: Props) {
    const [note, setNote] = useState('');
    const [savedNote, setSavedNote] = useState('');
    const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [adding, setAdding] = useState(false);
    const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [errors, setErrors] = useState<string[]>([]);
    const [noteSaved, setNoteSaved] = useState(false);
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

    const atLimit = attachments.length >= MAX_ATTACHMENTS;

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
                <p className="text-[11px] text-[#666666] italic">No attachments.</p>
            ) : (
                <ul className="space-y-1.5">
                    {attachments.map(a => (
                        <li key={a.id} className="flex items-center gap-2 bg-[#1a1a1a] border border-[#333] rounded-lg px-2.5 py-1.5">
                            <FileIcon ext={a.ext} />
                            <div className="min-w-0 flex-1">
                                <div className="text-xs text-white truncate" title={a.name}>{a.name}</div>
                                <div className="text-[10px] text-[#777777]">{formatBytes(a.size)}</div>
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
                                    <button onClick={() => handleOpen(a.id)} title="Open" className="text-gray-500 hover:text-white transition-colors cursor-pointer p-1">
                                        <ExternalLink className="w-3.5 h-3.5" />
                                    </button>
                                    <button onClick={() => handleSaveAs(a.id)} title="Save As" className="text-gray-500 hover:text-white transition-colors cursor-pointer p-1">
                                        <Download className="w-3.5 h-3.5" />
                                    </button>
                                    {canEdit && (
                                        <button onClick={() => setConfirmRemoveId(a.id)} title="Remove" className="text-gray-500 hover:text-red-400 transition-colors cursor-pointer p-1">
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    )}
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {canEdit && (
                <div className="flex items-center gap-3">
                    <button
                        onClick={handleAdd}
                        disabled={adding || atLimit}
                        className="flex items-center gap-1.5 text-[11px] font-bold text-gray-300 hover:text-white bg-[#272727] hover:bg-[#3f3f3f] px-3 py-1.5 rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                        {adding ? 'Adding' : 'Add Attachment'}
                    </button>
                    <span className="flex items-center gap-1 text-[10px] text-[#777777]">
                        <Paperclip className="w-3 h-3" />
                        {attachments.length} of {MAX_ATTACHMENTS}
                    </span>
                </div>
            )}

            {errors.length > 0 && (
                <div className="text-[10px] text-red-400 bg-red-900/20 border border-red-500/30 rounded-md px-2 py-1.5 space-y-0.5">
                    {errors.map((e, i) => <div key={i}>{e}</div>)}
                </div>
            )}
        </div>
    );
}
