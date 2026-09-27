import type { MouseEvent } from 'react';
import { BRAND } from '../branding';

interface Props {
    onContextMenu?: (e: MouseEvent) => void;
    className?: string;
    /** Part of a window drag area (the title bar): pressing on it drags the window. */
    dragRegion?: boolean;
}

/**
 * BRAND.logo, drawn in the active theme's primary accent instead of always showing its baked-in red. The logo is a flat
 * single-color silhouette, kept here as vector paths (BRAND.mark, traced from the PNG), so it is an inline shape filled
 * with `var(--k-accent)`: there is no image to load, so it is there with the first paint (a mask over the PNG had to load
 * first, and blinked after every reload). `onContextMenu` still gets the real BRAND.logo URL to save (see App.tsx's
 * handleSaveImageAs), not this drawing.
 */
export function BrandLogo({ onContextMenu, className = 'w-8 h-8', dragRegion = false }: Props) {
    const { w, h, d } = BRAND.mark;
    return (
        <svg
            role="img"
            aria-label={BRAND.name}
            viewBox={`0 0 ${w} ${h}`}
            preserveAspectRatio="xMidYMid meet"
            onContextMenu={onContextMenu}
            // In the title bar the logo is part of what drags the window (the path ignores the pointer, so the press lands here).
            {...(dragRegion ? { 'data-tauri-drag-region': '' } : {})}
            className={`${className} block pointer-events-auto shrink-0`}
            style={{ color: 'var(--k-accent)' }}
        >
            <path d={d} fill="currentColor" fillRule="evenodd" pointerEvents="none" />
        </svg>
    );
}
