import type { ReactNode } from 'react';
import { decodeWdbs, openExternalUrl } from '../api';
import { linkKindLabel, openInternalLink, parseInternalHref } from '../lib/internal-links';
import { useWorkspace } from '../hooks/useWorkspace';

/**
 * The link renderer for every markdown view (pass as `components={{ a: MarkdownLink }}` together
 * with `urlTransform={markdownUrlTransform}`). An ordinary link opens in the browser; an in-app
 * link (`kinesis://glossary/...`) opens that part of the app.
 */
export function MarkdownLink({ href, title, children }: { href?: string; title?: string; children?: ReactNode }) {
    const { labels } = useWorkspace();
    const internal = parseInternalHref(href);
    if (internal) {
        const target = internal.kind === 'drive' ? decodeWdbs(internal.key) || internal.key : internal.key;
        return (
            <a
                href="#"
                onClick={(e) => {
                    e.preventDefault();
                    openInternalLink(internal.kind, internal.key);
                }}
                title={`${linkKindLabel(internal.kind, labels)}: ${target}`}
                className="text-red-500 hover:text-red-400 underline decoration-dotted decoration-red-500/60 underline-offset-4"
            >
                {children}
            </a>
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
