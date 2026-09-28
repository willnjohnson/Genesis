import { useState, type DragEvent } from 'react';

/**
 * Native HTML5 drag-and-drop reordering for a flat, id-keyed list: drop a row directly onto another
 * to move it straight there in one step (fifth to first, not four "move up" clicks). No library —
 * matches how the rest of the app hand-rolls this kind of interaction rather than reaching for one.
 *
 * Which half of the hovered row the pointer is over decides before-it or after-it — not always
 * "before", which would make the last spot in the list unreachable (nothing to drop "onto" after the
 * last row). The caller renders `<DropIndicator side={dropSide(item)} />` as a child of a
 * `relative`-positioned row: a thin line floating just above or below it, not the row's own border,
 * so it reads as "between these two rows" rather than as part of the row itself. The caller owns the
 * actual list/how it's persisted; this only tracks drag state and computes the reordered array on
 * drop. Used by SequenceModal.tsx (Drive Sequences) and AttachmentsPanel.tsx (attachments and
 * links, reordered independently within their own tab).
 *
 * On Windows, dropping only works at all once the window's `disable_drag_drop_handler()` is set
 * (src-tauri/src/lib.rs) — Tauri's native drag-drop handler otherwise swallows the browser's own
 * drag events first, which is what shows as a permanent "not allowed" cursor no `preventDefault()`
 * here can fix.
 */
export function useDragReorder<T>(items: T[], keyOf: (item: T) => string | number) {
    const [draggingKey, setDraggingKey] = useState<string | number | null>(null);
    const [over, setOver] = useState<{ key: string | number; side: 'before' | 'after' } | null>(null);

    const rowProps = (item: T, onReordered: (newOrder: T[]) => void) => {
        const key = keyOf(item);
        return {
            draggable: true,
            onDragStart: (e: DragEvent<HTMLElement>) => {
                e.dataTransfer.effectAllowed = 'move';
                // Firefox won't start a drag at all unless some data is set.
                e.dataTransfer.setData('text/plain', String(key));
                setDraggingKey(key);
            },
            onDragOver: (e: DragEvent<HTMLElement>) => {
                // Without this, the browser refuses the drop outright (permanent "not allowed" cursor).
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (draggingKey == null || key === draggingKey) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const side = e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
                setOver(prev => (prev?.key === key && prev.side === side ? prev : { key, side }));
            },
            onDragLeave: (e: DragEvent<HTMLElement>) => {
                // Fires when moving onto a child element too, which isn't actually leaving the row —
                // only clear once the pointer has left the row's own box.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setOver(prev => (prev?.key === key ? null : prev));
                }
            },
            onDrop: (e: DragEvent<HTMLElement>) => {
                e.preventDefault();
                e.stopPropagation();
                const from = draggingKey;
                const side = over?.key === key ? over.side : 'before';
                setDraggingKey(null);
                setOver(null);
                if (from == null || from === key) return;
                const fromIndex = items.findIndex(i => keyOf(i) === from);
                let toIndex = items.findIndex(i => keyOf(i) === key);
                if (fromIndex === -1 || toIndex === -1) return;
                if (side === 'after') toIndex += 1;
                const next = [...items];
                const [moved] = next.splice(fromIndex, 1);
                // The removal above shifts everything after it left by one; account for that before
                // re-inserting, so "after the last item" (toIndex === items.length) still lands last.
                if (fromIndex < toIndex) toIndex -= 1;
                next.splice(toIndex, 0, moved);
                onReordered(next);
            },
            onDragEnd: () => { setDraggingKey(null); setOver(null); },
        };
    };

    const isDragging = (item: T) => keyOf(item) === draggingKey;
    /** Which edge of `item` to show the floating drop line on right now, or `null` for none. */
    const dropSide = (item: T): 'before' | 'after' | null => (over?.key === keyOf(item) ? over.side : null);

    return { rowProps, isDragging, dropSide };
}

/** The floating insertion line itself — a child of a `relative`-positioned row, not the row's own
 *  border, so it reads as sitting in the gap between two rows rather than as part of either one.
 *  Renders nothing for `side: null`. */
export function DropIndicator({ side }: { side: 'before' | 'after' | null }) {
    if (!side) return null;
    return (
        <div
            aria-hidden
            className="absolute inset-x-0 h-[3px] rounded-full pointer-events-none z-10"
            style={{ [side === 'before' ? 'top' : 'bottom']: '-2px', backgroundColor: 'var(--k-accent)' }}
        />
    );
}
