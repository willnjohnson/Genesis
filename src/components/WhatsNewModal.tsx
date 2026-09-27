import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Megaphone } from 'lucide-react';
import whatsNew from '../data/whats-new.md?raw';
import { Modal } from './Modal';

/** What changed in the current version, written in src/data/whats-new.md (plain markdown, so it is edited like any
 *  document and kept in step with the release notes). */
export function WhatsNewModal({ onClose }: { onClose: () => void }) {
    // The first heading ("# Changelog (v0.4.8)") gives the version, shown under the window's title; it is not repeated in the text.
    const [, heading = '', body = whatsNew] = whatsNew.match(/^#\s+(.+)\r?\n([\s\S]*)$/) ?? [];
    const version = heading.match(/v\d[\w.]*/)?.[0];
    return (
        <Modal onClose={onClose} icon={Megaphone} title="What's New" subtitle={version ? `Version ${version.slice(1)}` : undefined} size="lg">
            <div className={[
                // Airy rather than dense: roomier lines and gaps, body text a step softer than white so the bold names and
                // headings carry the structure. The section ("Added") is the big heading with a line under it; the group
                // inside it ("Title Bar") is a step smaller.
                'prose dark:prose-invert prose-sm max-w-none select-none leading-7 text-gray-300',
                'prose-h2:text-xl prose-h2:font-bold prose-h2:mt-0 prose-h2:mb-5 prose-h2:pb-2.5 prose-h2:border-b prose-h2:border-[#303030]',
                'prose-h3:text-[15px] prose-h3:font-semibold prose-h3:text-gray-200 prose-h3:mt-8 prose-h3:mb-3',
                'prose-strong:font-semibold prose-strong:text-gray-100',
                'prose-ul:my-3 prose-ul:pl-5 prose-li:my-3 prose-li:pl-1 prose-li:marker:text-gray-600',
                // The sub-bullets under a bullet: tighter and a shade quieter.
                '[&_ul_ul]:mt-2 [&_ul_ul]:mb-0 [&_ul_ul_li]:my-1.5 [&_ul_ul_li]:text-gray-400',
            ].join(' ')}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
            </div>
        </Modal>
    );
}
