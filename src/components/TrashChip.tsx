import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';
import { TRASH_RESTORED_EVENT, trashDiscard, trashEmpty, trashRestore, type TrashKind } from '../api';
import { useTrash } from '../hooks/useTrash';
import { useMenuDismiss, useMenuPlace } from './ContextMenu';

interface Props {
    kind: TrashKind;
    /** How wide the status bar must be (a container-query size) before the words show beside the icon; narrower
     *  than that it's just the trash icon, and its tooltip says how many. */
    labelFrom?: '2xl' | '4xl' | '6xl';
    /** Opens the Trash window for this kind (App owns it, so the command palette can open it too). */
    onOpen: () => void;
}

// Written out in full (Tailwind needs the class names as they are): the words appear from this bar width up, and
// the icon, which only stands in for them, goes.
const SHOW_WORDS = { '2xl': '@2xl:inline', '4xl': '@4xl:inline', '6xl': '@6xl:inline' } as const;
const HIDE_ICON = { '2xl': '@2xl:hidden', '4xl': '@4xl:hidden', '6xl': '@6xl:hidden' } as const;

/** How many of the newest deleted items the right-click menu lists; the rest are behind "See more". */
const MENU_ITEMS = 4;

/** The right-click menu on the Trash chip: the newest deleted items, each with Undo (put it back) and Delete (for good), shown while the row is hovered, "See
 *  more" for the Trash window when there are more, and Empty Trash. Stays open for the next one; it goes when the
 *  Trash is empty (the chip is then gone) or on a click elsewhere. */
function TrashMenu({ kind, x, y, onClose, onSeeMore }: { kind: TrashKind; x: number; y: number; onClose: () => void; onSeeMore: () => void }) {
    const { entries } = useTrash(kind);
    const box = useRef<HTMLDivElement>(null);
    // Opens upward: the chip is in the bar along the bottom of the window.
    const at = useMenuPlace(box, x, y, true);
    useMenuDismiss(box, onClose);
    // Why a restore didn't happen, by item (it may have been made again since).
    const [errors, setErrors] = useState<Record<number, string>>({});
    const [busy, setBusy] = useState<number | null>(null);

    const newest = [...entries].sort((a, b) => b.deleted_at - a.deleted_at);
    const shown = newest.slice(0, MENU_ITEMS);
    const remaining = newest.length - shown.length;

    const restore = async (id: number) => {
        setBusy(id);
        setErrors(prev => { const { [id]: _gone, ...rest } = prev; return rest; });
        try {
            await trashRestore(id);
            // Whatever shows that kind of item reloads (App listens).
            window.dispatchEvent(new CustomEvent(TRASH_RESTORED_EVENT, { detail: kind }));
        } catch (e) {
            setErrors(prev => ({ ...prev, [id]: typeof e === 'string' ? e : (e as Error)?.message ?? "Couldn't restore this." }));
        } finally {
            setBusy(null);
        }
    };

    return createPortal(
        <div
            ref={box}
            role="menu"
            style={at}
            className="fixed z-[250] w-[22rem] max-w-[calc(100vw-1rem)] bg-[#272727] border border-[#3f3f3f] rounded-lg shadow-xl py-1 select-none"
            onContextMenu={(e) => e.preventDefault()}
            onClick={(e) => e.stopPropagation()}
        >
            {shown.map(entry => (
                <div key={entry.id} className="group px-3 py-1.5 hover:bg-[#3f3f3f] transition-colors">
                    <div className="flex items-center gap-2">
                        <span className="flex-1 min-w-0 truncate text-sm text-white" title={entry.label}>{entry.label}</span>
                        <button
                            type="button"
                            onClick={() => { void restore(entry.id); }}
                            disabled={busy === entry.id}
                            className="shrink-0 px-2 py-1 rounded-md text-xs font-semibold text-gray-200 hover:text-white hover:bg-[#525252] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-50 cursor-pointer transition-colors"
                        >
                            Undo
                        </button>
                        <button
                            type="button"
                            onClick={() => { void trashDiscard(entry.id); }}
                            title="Delete for good"
                            className="shrink-0 px-2 py-1 rounded-md text-xs font-semibold text-gray-300 hover:text-red-400 hover:bg-[#525252] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 cursor-pointer transition-colors"
                        >
                            Delete
                        </button>
                    </div>
                    {errors[entry.id] && <div className="mt-1 text-xs text-red-400">{errors[entry.id]}</div>}
                </div>
            ))}
            {remaining > 0 && (
                <button
                    type="button"
                    onClick={() => { onClose(); onSeeMore(); }}
                    className="w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-[#3f3f3f] cursor-pointer"
                >
                    See more ({remaining} remaining)
                </button>
            )}
            <div className="border-t border-[#3f3f3f] mt-1 pt-1">
                <button
                    type="button"
                    onClick={() => { onClose(); void trashEmpty(kind); }}
                    className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-sm text-red-400 hover:bg-[#3f3f3f] cursor-pointer"
                >
                    <Trash2 className="w-3.5 h-3.5" />
                    Empty Trash
                </button>
            </div>
        </div>,
        document.body,
    );
}

/** "3 in Trash" for the status bar: shown while there's something in this section's Trash. A click opens the Trash
 *  window (TrashModal) to put things back; a right-click opens a short menu of the newest items to restore or delete
 *  without opening it. */
export function TrashChip({ kind, labelFrom = '4xl', onOpen }: Props) {
    const { count } = useTrash(kind);
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    // The chip stays mounted (drawing nothing) while the Trash is empty, so an open menu has to be closed here, or it
    // would come back the next time something is deleted.
    useEffect(() => { if (count === 0) setMenu(null); }, [count]);
    if (count === 0) return null;

    return (
        <>
            <button
                type="button"
                onClick={onOpen}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }); }}
                title={`${count} in Trash`}
                aria-label={`${count} in Trash`}
                className="shrink-0 flex items-center gap-1.5 whitespace-nowrap px-1.5 py-0.5 text-[11px] font-semibold text-gray-400 hover:text-white hover:bg-[#272727] transition-colors cursor-pointer"
            >
                <Trash2 className={`w-3 h-3 ${HIDE_ICON[labelFrom]}`} />
                <span className={`hidden ${SHOW_WORDS[labelFrom]}`}><span className="text-white">{count}</span> in Trash</span>
            </button>
            {menu && <TrashMenu kind={kind} x={menu.x} y={menu.y} onClose={() => setMenu(null)} onSeeMore={onOpen} />}
        </>
    );
}
