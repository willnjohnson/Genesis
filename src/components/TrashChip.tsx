import { Trash2 } from 'lucide-react';
import type { TrashKind } from '../api';
import { useTrash } from '../hooks/useTrash';

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

/** "3 in Trash" for the status bar: shown while there's something in this section's Trash, and opens the Trash
 *  window (TrashModal) to put things back. */
export function TrashChip({ kind, labelFrom = '4xl', onOpen }: Props) {
    const { count } = useTrash(kind);
    if (count === 0) return null;

    return (
        <button
            type="button"
            onClick={onOpen}
            title={`${count} in Trash`}
            aria-label={`${count} in Trash`}
            className="shrink-0 flex items-center gap-1.5 whitespace-nowrap px-1.5 py-0.5 text-[11px] font-semibold text-gray-400 hover:text-white hover:bg-[#272727] transition-colors cursor-pointer"
        >
            <Trash2 className={`w-3 h-3 ${HIDE_ICON[labelFrom]}`} />
            <span className={`hidden ${SHOW_WORDS[labelFrom]}`}><span className="text-white">{count}</span> in Trash</span>
        </button>
    );
}
