import type { ReactNode } from 'react';
import { decodeWdbs, openExternalUrl } from '../api';
import { linkKindLabel, openInternalLink, parseInternalHref } from '../lib/internal-links';
import { useWorkspace } from '../hooks/useWorkspace';
import { useBioLinkPreview, useGlossaryPreview } from './GlossaryPreview';
import { useSequenceLinkPreview } from './SequenceCard';
import { useVideoPreview } from './VideoPreview';
import { PlaylistEmbed, VideoEmbed } from './LinkEmbed';

/**
 * The link renderer for every markdown view (pass as `components={{ a: MarkdownLink }}` together
 * with `urlTransform={markdownUrlTransform}`). An ordinary link opens in the browser; an in-app
 * link (`kinesis://glossary/...`) opens that part of the app.
 */
export function MarkdownLink({ href, title, children, 'data-embed': embed }: { href?: string; title?: string; children?: ReactNode; 'data-embed'?: string }) {
    const { labels } = useWorkspace();
    const internal = parseInternalHref(href);
    // A glossary link previews its definition on hover, in place of the plain tooltip the other kinds get.
    const preview = useGlossaryPreview(internal?.kind === 'glossary' ? internal.key : '');
    const bioPreview = useBioLinkPreview(internal?.kind === 'bio' ? internal.key : '');
    // A playlist link previews as a playlist card (first video's thumbnail, how many videos, what it starts with).
    const sequencePreview = useSequenceLinkPreview(internal?.kind === 'playlist' ? internal.key : '');
    // A video link previews as the video's card.
    const videoPreview = useVideoPreview(internal?.kind === 'video' ? internal.key : '');
    if (internal) {
        const target = internal.kind === 'drive' ? decodeWdbs(internal.key) || internal.key : internal.key;
        const hover = internal.kind === 'glossary' ? preview
            : internal.kind === 'bio' ? bioPreview
            : internal.kind === 'playlist' ? sequencePreview
            : internal.kind === 'video' ? videoPreview
            : null;
        const link = (
            <>
                <a
                    href="#"
                    onClick={(e) => {
                        e.preventDefault();
                        openInternalLink(internal.kind, internal.key);
                    }}
                    title={hover ? undefined : `${linkKindLabel(internal.kind, labels)}: ${target}`}
                    {...(hover ? hover.handlers : {})}
                    // The real target doesn't otherwise survive into the DOM (href above is just
                    // "#") — this is what a Terms chip's jump-to-summary click looks for
                    // (see Sidebar.tsx's handleJumpToTerm).
                    {...(internal.kind === 'glossary' ? { 'data-glossary-term': internal.key } : {})}
                    className="text-red-500 hover:text-red-400 underline decoration-dotted decoration-red-500/60 underline-offset-4"
                >
                    {children}
                </a>
                {hover?.card}
            </>
        );
        // On a line of its own (lib/remark-embeds.ts marks it), a video or playlist link shows as its card; the plain
        // link is what shows if the target is gone.
        if (embed && internal.kind === 'video') return <VideoEmbed videoId={internal.key} fallback={link} />;
        if (embed && internal.kind === 'playlist') return <PlaylistEmbed drive={internal.key} fallback={link} />;
        return link;
    }
    return (
        <a
            href="#"
            title={title}
            onClick={(e) => {
                e.preventDefault();
                if (href) openExternalUrl(href);
            }}
            className="text-red-500 hover:text-red-400 underline decoration-red-500/30 underline-offset-4"
        >
            {children}
        </a>
    );
}
