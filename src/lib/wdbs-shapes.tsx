import { Star, Diamond, Heart } from 'lucide-react';
import type { WdbsShapeKey } from '../api';

// One entry per WDBS_SHAPE_KEYS value (api.ts) — keep both in sync with db::WDBS_SHAPES on the
// Rust side. `label` is what WdbsColorMenu's "Markers" list shows for each. (Called markers in the UI;
// "shape" in code and in tblWDBS.WDShape.)
export const WDBS_SHAPE_OPTIONS: { key: WdbsShapeKey; label: string }[] = [
    { key: 'square', label: 'Square' },
    { key: 'circle', label: 'Circle' },
    { key: 'star', label: 'Star' },
    { key: 'diamond', label: 'Diamond' },
    { key: 'heart', label: 'Heart' },
];

// Renders one color decoration chip: `shape` (WdbsNode.shape, `null`/unrecognized treated as
// "square" by the caller) filled with `colorValue` (a resolved CSS color — typically one of
// index.css's --k-drive-* tokens via getWdbsColorValue). Square/circle are a plain filled `<span>`
// at a `w-3.5 h-3.5` footprint, edge to edge. Star/diamond/heart borrow lucide's own outline glyphs and
// just recolor both their stroke and fill to `colorValue`, which reads as a solid shape without
// needing a hand-drawn path — but lucide's glyph sits inset within its own viewBox (stroke padding
// around the actual path), so at that same box it reads visibly smaller than the square/circle's
// flush fill. The glyph itself is drawn bigger (`w-4.5 h-4.5`) to compensate, but its *layout box*
// stays the same `w-3.5 h-3.5` as every other shape (a centering wrapper, not the icon's own
// className) — sizing the icon's own box instead pushed everything after it (the Drive's icon,
// its name) rightward whenever the shape happened to be a star or diamond, since a wider box in a
// flex row shoves its siblings over. The glyph is centered and allowed to overflow that box a
// couple pixels on each side instead, which is invisible here (nothing clips it) and keeps every
// row's text starting at the same x position regardless of which shape is picked. The glyph also
// needs its own `shrink-0`, separate from the wrapper's: the wrapper is `inline-flex`, and without
// it flexbox's default shrink-to-fit quietly squeezes the 18px icon back down to fit the 14px box
// it sits in, undoing the whole point of sizing it up.
export function WdbsShapeSwatch({ shape, colorValue, className = '', borderClassName = '' }: {
    shape: string;
    colorValue: string;
    className?: string;
    borderClassName?: string;
}) {
    switch (shape) {
        case 'circle':
            return (
                <span
                    className={`w-3.5 h-3.5 shrink-0 rounded-full border ${borderClassName} ${className}`}
                    style={{ backgroundColor: colorValue }}
                />
            );
        case 'star':
            return (
                <span className={`w-3.5 h-3.5 shrink-0 inline-flex items-center justify-center ${className}`}>
                    <Star className="w-4.5 h-4.5 shrink-0" style={{ color: colorValue }} fill={colorValue} />
                </span>
            );
        case 'diamond':
            return (
                <span className={`w-3.5 h-3.5 shrink-0 inline-flex items-center justify-center ${className}`}>
                    <Diamond className="w-4.5 h-4.5 shrink-0" style={{ color: colorValue }} fill={colorValue} />
                </span>
            );
        case 'heart':
            return (
                <span className={`w-3.5 h-3.5 shrink-0 inline-flex items-center justify-center ${className}`}>
                    <Heart className="w-4.5 h-4.5 shrink-0" style={{ color: colorValue }} fill={colorValue} />
                </span>
            );
        case 'square':
        default:
            return (
                <span
                    className={`w-3.5 h-3.5 shrink-0 rounded-sm border ${borderClassName} ${className}`}
                    style={{ backgroundColor: colorValue }}
                />
            );
    }
}
