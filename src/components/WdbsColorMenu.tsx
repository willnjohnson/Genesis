import { useEffect, useRef } from 'react';
import { Ban } from 'lucide-react';
import { WDBS_COLOR_OPTIONS } from '../lib/wdbs-colors';
import { WDBS_SHAPE_OPTIONS, WdbsShapeSwatch } from '../lib/wdbs-shapes';

interface WdbsColorMenuProps {
    x: number;
    y: number;
    segment: string;
    currentColor: string | null;
    currentShape: string | null;
    onSelectColor: (color: string) => void;
    onSelectShape: (shape: string) => void;
    onClear: () => void;
    onClose: () => void;
    saving?: boolean;
    error?: string | null;
}

// A neutral stand-in for the "Markers" list's previews when no color has been picked yet — there's
// nothing real to show a shape filled with, but the row still needs to render something.
const NO_COLOR_PREVIEW = 'var(--k-text-gray-500)';

/**
 * Small popover ("Decoration for <node>") opened by right-clicking a Warp Drive taxonomy node in WdbsTreePanel — lets
 * the user pick the color decoration's color (left list) and its marker, i.e. container shape (right list:
 * square/circle/star/diamond/heart),
 * shown as a small chip before that node's icon in the tree, stored as tblWDBS.WDColor/WDShape
 * (see api.ts's setWdbsColor/setWdbsShape). The two are independent — picking a color leaves the
 * shape alone and vice versa — except for "None", which clears both at once: a color decoration
 * with no color has nothing to display, so leaving a shape behind on its own would just be an
 * inert, invisible setting. Each pick commits immediately and the popover stays open afterward, same as
 * WdbsIconMenu, since there are two independent choices to make here.
 */
export function WdbsColorMenu({ x, y, segment, currentColor, currentShape, onSelectColor, onSelectShape, onClear, onClose, saving = false, error }: WdbsColorMenuProps) {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    const MENU_WIDTH = 320;
    const MAX_MENU_HEIGHT = 420;
    const left = Math.min(x, window.innerWidth - MENU_WIDTH - 12);
    const top = Math.min(y, window.innerHeight - MAX_MENU_HEIGHT - 12);

    const effectiveShape = currentShape ?? 'square';
    const shapePreviewColor = currentColor
        ? WDBS_COLOR_OPTIONS.find(o => o.key === currentColor)?.cssVar
        : undefined;

    const rowClass = (on: boolean) =>
        `flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 ${on ? 'bg-red-600 text-white' : 'bg-[#121212] text-gray-400 hover:text-white hover:bg-[#272727]'}`;
    const columnTitle = 'text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5 shrink-0';
    // Each column scrolls on its own: the colors outnumber the shapes, so one shared scroll would drag the shapes away.
    const columnList = 'flex flex-col gap-1 overflow-y-auto custom-scrollbar pr-0.5 min-h-0';

    return (
        <div
            ref={containerRef}
            style={{ left, top, width: MENU_WIDTH, maxHeight: MAX_MENU_HEIGHT }}
            className="fixed z-[200] bg-[#1a1a1a] border border-[#333] rounded-xl shadow-2xl p-3 animate-in fade-in zoom-in-95 duration-150 flex flex-col"
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        >
            <div className="text-xs font-bold text-white mb-2 truncate shrink-0">
                Decoration for {segment}
            </div>
            <div className="flex gap-2 min-h-0">
                <div className="flex-1 min-w-0 flex flex-col min-h-0">
                    <div className={columnTitle}>Colors</div>
                    <div className={columnList}>
                        <button onClick={onClear} disabled={saving} className={rowClass(!currentColor)}>
                            <Ban className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">None</span>
                        </button>
                        {WDBS_COLOR_OPTIONS.map(({ key, label, cssVar }) => (
                            <button key={key} onClick={() => onSelectColor(key)} disabled={saving} className={rowClass(currentColor === key)}>
                                <span
                                    className="w-3.5 h-3.5 shrink-0 rounded-sm border border-white/20"
                                    style={{ backgroundColor: `var(${cssVar})` }}
                                />
                                <span className="truncate">{label}</span>
                            </button>
                        ))}
                    </div>
                </div>
                <div className="flex-1 min-w-0 flex flex-col min-h-0">
                    <div className={columnTitle}>Markers</div>
                    <div className={columnList}>
                        {WDBS_SHAPE_OPTIONS.map(({ key, label }) => (
                            <button key={key} onClick={() => onSelectShape(key)} disabled={saving} className={rowClass(effectiveShape === key)}>
                                <WdbsShapeSwatch
                                    shape={key}
                                    colorValue={shapePreviewColor ? `var(${shapePreviewColor})` : NO_COLOR_PREVIEW}
                                    borderClassName="border-white/20"
                                />
                                <span className="truncate">{label}</span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
            {error && (
                <div className="mt-2 text-[10px] text-red-400 bg-red-900/20 border border-red-500/30 rounded-md px-2 py-1.5 shrink-0">
                    {error}
                </div>
            )}
        </div>
    );
}
