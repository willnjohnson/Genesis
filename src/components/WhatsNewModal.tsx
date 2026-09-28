import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Megaphone, ChevronLeft, ChevronRight } from 'lucide-react';
import { WHATS_NEW_ENTRIES } from '../lib/whats-new';
import { Modal } from './Modal';

/** What changed, one release per entry, written in src/data/whats-new.md as consecutive "# " sections
 *  (plain markdown, so it's edited like any document and kept in step with the release notes) — newest
 *  first, since a new release adds its own section above the last one rather than editing it in place.
 *  Opens on the newest; "<"/">" step toward more recent/older without ever changing what's already there. */
export function WhatsNewModal({ onClose }: { onClose: () => void }) {
    const [index, setIndex] = useState(0);
    const entry = WHATS_NEW_ENTRIES[index] ?? { version: '', heading: '', body: '' };
    const atNewest = index === 0;
    const atOldest = index >= WHATS_NEW_ENTRIES.length - 1;

    return (
        <Modal
            onClose={onClose}
            icon={Megaphone}
            title="What's New"
            subtitle={entry.version ? `Version ${entry.version.slice(1)}` : undefined}
            size="lg"
            headerExtra={WHATS_NEW_ENTRIES.length > 1 && (
                <div className="flex items-center gap-0.5 shrink-0">
                    <button
                        type="button"
                        onClick={() => setIndex(i => Math.max(0, i - 1))}
                        disabled={atNewest}
                        title="More recent"
                        aria-label="More recent version"
                        className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-gray-400"
                    >
                        <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                        type="button"
                        onClick={() => setIndex(i => Math.min(WHATS_NEW_ENTRIES.length - 1, i + 1))}
                        disabled={atOldest}
                        title="Older"
                        aria-label="Older version"
                        className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-gray-400"
                    >
                        <ChevronRight className="w-4 h-4" />
                    </button>
                </div>
            )}
        >
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
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.body}</ReactMarkdown>
            </div>
        </Modal>
    );
}
