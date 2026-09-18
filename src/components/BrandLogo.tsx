import type { MouseEvent } from 'react';
import { BRAND } from '../branding';

interface Props {
    onContextMenu?: (e: MouseEvent) => void;
    className?: string;
}

/**
 * BRAND.logo, tinted to the active theme's primary accent instead of always showing its baked-in
 * red. The source PNG is a flat single-color silhouette (see src/assets/kinesis.png/genesis.png),
 * so a CSS mask is the right tool: painting a `var(--k-accent)`-colored box and clipping it to the
 * logo's alpha shape recolors it correctly for any theme, which a plain `<img>` (always showing
 * its own baked-in pixel colors) can't do. `onContextMenu` still gets the real BRAND.logo URL to
 * save (see App.tsx's handleSaveImageAs), not the recolored mask.
 */
export function BrandLogo({ onContextMenu, className = 'w-8 h-8' }: Props) {
    return (
        <div
            role="img"
            aria-label={BRAND.name}
            onContextMenu={onContextMenu}
            className={`${className} pointer-events-auto shrink-0 bg-[var(--k-accent)]`}
            style={{
                WebkitMaskImage: `url(${BRAND.logo})`,
                maskImage: `url(${BRAND.logo})`,
                WebkitMaskSize: 'contain',
                maskSize: 'contain',
                WebkitMaskRepeat: 'no-repeat',
                maskRepeat: 'no-repeat',
                WebkitMaskPosition: 'center',
                maskPosition: 'center',
            }}
        />
    );
}
