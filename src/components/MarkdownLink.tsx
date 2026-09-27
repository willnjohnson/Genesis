import type { ReactNode } from 'react';
import { decodeWdbs, openExternalUrl } from '../api';
import { linkKindLabel, openInternalLink, parseInternalHref } from '../lib/internal-links';
import { useWorkspace } from '../hooks/useWorkspace';
import { useBioLinkPreview, useGlossaryPreview } from './GlossaryPreview';

/**
 * The link renderer for every markdown view (pass as `components={{ a: MarkdownLink }}` together
 * with `urlTransform={markdownUrlTransform}`). An ordinary link opens in the browser; an in-app
 * link (`kinesis://glossary/...`) opens that part of the app.
 */
export function MarkdownLink({ href, title, children }: { href?: string; title?: string; children?: ReactNode }) {
    const { labels } = useWorkspace();
    const internal = parseInternalHref(href);
    // A glossary link previews its definition on hover, in place of the plain tooltip the other kinds get.
    const preview = useGlossaryPreview(internal?.kind === 'glossary' ? internal.key : '');
    const bioPreview = useBioLinkPreview(internal?.kind === 'bio' ? internal.key : '');
    if (internal) {
        const target = internal.kind === 'drive' ? decodeWdbs(internal.key) || internal.key : internal.key;
        const hover = internal.kind === 'glossary' ? preview : internal.kind === 'bio' ? bioPreview : null;
        return (
            <>
                <a
                    href="#"
                    onClick={(e) => {
                        e.preventDefault();
                        openInternalLink(internal.kind, internal.key);
                    }}
                    title={hover ? undefined : `${linkKindLabel(internal.kind, labels)}: ${target}`}
                    {...(hover ? hover.handlers : {})}
                    className="text-red-500 hover:text-red-400 underline decoration-dotted decoration-red-500/60 underline-offset-4"
                >
                    {children}
                </a>
                {hover?.card}
            </>
        );
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
