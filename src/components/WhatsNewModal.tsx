import { useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Megaphone, ChevronLeft, ChevronRight, Check, Loader2, Wand2 } from 'lucide-react';
import { WHATS_NEW_ENTRIES } from '../lib/whats-new';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { linkChannelInfoFooters } from '../api';
import { Modal } from './Modal';

/** One-off fixes a release can offer in its notes: a link to `action:<name>` in whats-new.md shows as a button that
 *  runs it (and says how it went). Only the app's own notes are drawn here, so only these can be asked for. */
const ACTIONS: Record<string, {
    run: () => Promise<number>;
    done: (count: number) => string;
    /** The backend event reporting { done, total } while it runs, shown in the button as "done / total <noun>". */
    progressEvent?: string;
    noun?: string;
}> = {
    // v0.5.1: summaries saved before the creator's name in "Channel Info:" linked to their biography.
    'link-channel-info': {
        run: linkChannelInfoFooters,
        done: n => (n === 0 ? 'Nothing to update: every summary is already linked.' : `Linked the creator in ${n} ${n === 1 ? 'summary' : 'summaries'}.`),
        progressEvent: 'link_channel_info_progress',
        noun: 'summaries',
    },
};

function ActionButton({ name, children }: { name: string; children: ReactNode }) {
    const action = ACTIONS[name];
    const [state, setState] = useState<{ busy: boolean; message: string | null; error: boolean }>({ busy: false, message: null, error: false });
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    if (!action) return <>{children}</>;
    const go = async () => {
        setState({ busy: true, message: null, error: false });
        setProgress(null);
        // Listening before it starts, so the first report isn't missed. (Outside the app there's nothing to hear.)
        let stop: UnlistenFn | undefined;
        if (action.progressEvent) {
            stop = await listen<{ done: number; total: number }>(action.progressEvent, e => setProgress(e.payload)).catch(() => undefined);
        }
        try {
            setState({ busy: false, message: action.done(await action.run()), error: false });
        } catch (e) {
            setState({ busy: false, message: typeof e === 'string' ? e : 'That didn\'t work. Try again in a moment.', error: true });
        } finally {
            stop?.();
            setProgress(null);
        }
    };
    const fmt = (n: number) => n.toLocaleString();
    return (
        <span className="not-prose inline-flex flex-wrap items-center gap-2 align-middle">
            <button
                type="button"
                onClick={() => void go()}
                disabled={state.busy}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-[#272727] hover:bg-[#3f3f3f] border border-[#3f3f3f] text-white text-xs font-semibold transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-default"
            >
                {state.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                {/* While it runs, the button says how far it's got: "Updating 120 / 3,000 summaries…". */}
                {state.busy && progress && progress.total > 0
                    ? <span className="tabular-nums">Updating {fmt(progress.done)} / {fmt(progress.total)} {action.noun ?? 'items'}…</span>
                    : children}
            </button>
            {state.message && (
                <span className={`inline-flex items-center gap-1 text-xs ${state.error ? 'text-red-400' : 'text-green-500'}`}>
                    {!state.error && <Check className="w-3.5 h-3.5" />}{state.message}
                </span>
            )}
        </span>
    );
}

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
                <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    urlTransform={url => (url.startsWith('action:') ? url : defaultUrlTransform(url))}
                    components={{
                        a: ({ href, children }) => (href?.startsWith('action:')
                            ? <ActionButton name={href.slice('action:'.length)}>{children}</ActionButton>
                            : <a href={href}>{children}</a>),
                    }}
                >
                    {entry.body}
                </ReactMarkdown>
            </div>
        </Modal>
    );
}
