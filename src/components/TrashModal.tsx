import { useEffect, useState } from 'react';
import { RotateCcw, Trash2, X } from 'lucide-react';
import { trashDiscard, trashEmpty, trashRestore, type TrashKind } from '../api';
import { useTrash } from '../hooks/useTrash';
import { useWorkspace } from '../hooks/useWorkspace';
import { Modal } from './Modal';

/** "just now", "3 min ago", "2 hr ago". */
function ago(ms: number, now: number): string {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    return `${Math.round(m / 60)} hr ago`;
}

interface Props {
    kind: TrashKind;
    onClose: () => void;
    /** Something was put back: whatever shows that kind of item should reload. */
    onRestored?: () => void;
}

/** The Trash for one kind of item (the Library's videos, or the Glossary's terms and tags): what was deleted this
 *  session, with a way to put each back or let it go. */
export function TrashModal({ kind, onClose, onRestored }: Props) {
    const { entries } = useTrash(kind);
    const { labels } = useWorkspace();
    const [now, setNow] = useState(() => Date.now());
    // Why a restore didn't happen, by item (it may have been made again since).
    const [errors, setErrors] = useState<Record<number, string>>({});
    const [busy, setBusy] = useState<number | null>(null);

    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 30_000);
        return () => window.clearInterval(timer);
    }, []);

    const where = kind === 'video' ? labels.aliasLibrary : labels.aliasGlossary;

    const restore = async (id: number) => {
        setBusy(id);
        setErrors(prev => { const { [id]: _gone, ...rest } = prev; return rest; });
        try {
            await trashRestore(id);
            onRestored?.();
        } catch (e) {
            setErrors(prev => ({ ...prev, [id]: typeof e === 'string' ? e : (e as Error)?.message ?? 'Couldn\'t restore this.' }));
        } finally {
            setBusy(null);
        }
    };

    return (
        <Modal
            onClose={onClose}
            icon={Trash2}
            title={`Trash: ${where}`}
            subtitle="Emptied when you quit"
            size="lg"
            bodyClassName="p-0"
            footer={
                <>
                    <button
                        type="button"
                        onClick={() => { void trashEmpty(kind); }}
                        disabled={entries.length === 0}
                        className="px-4 py-2 rounded-lg bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] disabled:opacity-40 disabled:cursor-default cursor-pointer text-white text-sm font-semibold transition-colors"
                    >
                        Empty Trash
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 cursor-pointer text-white text-sm font-semibold transition-colors"
                    >
                        Close
                    </button>
                </>
            }
        >
            {entries.length === 0 ? (
                <div className="px-6 py-12 text-center text-sm text-[#888888]">
                    Nothing in the Trash. What you delete stays here until you quit.
                </div>
            ) : (
                <ul className="divide-y divide-[#272727]">
                    {entries.map(entry => (
                        <li key={entry.id} className="px-6 py-3 flex items-center gap-4">
                            <div className="min-w-0 flex-1">
                                <div className="text-sm font-semibold text-white truncate" title={entry.label}>{entry.label}</div>
                                <div className="text-xs text-[#888888] truncate">
                                    {entry.detail ? `${entry.detail} · ` : ''}{ago(entry.deleted_at, now)}
                                </div>
                                {errors[entry.id] && <div className="mt-1 text-xs text-red-400">{errors[entry.id]}</div>}
                            </div>
                            <button
                                type="button"
                                onClick={() => { void restore(entry.id); }}
                                disabled={busy === entry.id}
                                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 cursor-pointer text-white text-xs font-semibold transition-colors"
                            >
                                <RotateCcw className="w-3.5 h-3.5" />
                                Restore
                            </button>
                            <button
                                type="button"
                                onClick={() => { void trashDiscard(entry.id); }}
                                title="Delete for good"
                                className="shrink-0 p-1.5 text-[#888888] hover:text-red-400 cursor-pointer transition-colors"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </Modal>
    );
}
