import { useState, type MouseEvent, type ReactNode } from 'react';
import { ExternalLink, UserSearch } from 'lucide-react';
import { openExternalUrl } from '../api';
import { openInternalLink } from '../lib/internal-links';
import { useFlags } from '../hooks/useFlags';
import { useWorkspace } from '../hooks/useWorkspace';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';

/** A creator's YouTube channel, from their handle ("@Name" or "Name") or channel id ("UC..."). Kinesis builds the address
 *  itself, so it opens without the external-link confirmation. */
export function youtubeChannelUrl(handle: string): string {
    const h = handle.trim().replace(/^@/, '');
    return /^UC[\w-]{22}$/.test(h) ? `https://www.youtube.com/channel/${h}` : `https://www.youtube.com/@${encodeURIComponent(h)}`;
}

/** The right-click menu for a creator, wherever their name shows (a biography link in text, the video sidebar's
 *  @handle): Visit YouTube Channel, and Open Biography. `onOpenBiography` replaces the usual way of opening it (the
 *  in-app link) where the place has its own. Returns what to put on the element's onContextMenu, and the menu to render. */
export function useCreatorMenu(handle: string | null | undefined, onOpenBiography?: () => void): { onContextMenu?: (e: MouseEvent) => void; menu: ReactNode } {
    const { flags } = useFlags();
    const { labels } = useWorkspace();
    const [at, setAt] = useState<{ x: number; y: number } | null>(null);
    const h = handle?.trim();
    if (!h) return { menu: null };
    const items: ContextMenuItem[] = [
        { label: 'Visit YouTube Channel', icon: ExternalLink, onClick: () => { void openExternalUrl(youtubeChannelUrl(h)); } },
        ...(flags.showBiography ? [{
            label: `Open ${labels.aliasBiography}`,
            icon: UserSearch,
            onClick: onOpenBiography ?? (() => openInternalLink('bio', h.replace(/^@/, ''))),
        }] : []),
    ];
    return {
        onContextMenu: (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setAt({ x: e.clientX, y: e.clientY });
        },
        menu: at ? <ContextMenu x={at.x} y={at.y} items={items} onClose={() => setAt(null)} /> : null,
    };
}
