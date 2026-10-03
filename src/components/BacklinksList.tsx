import { useEffect, useState } from 'react';
import { BookA, FileText, NotebookPen, Sparkles, UserSearch } from 'lucide-react';
import { getBacklinks, type Backlink } from '../api';
import { openInternalLink, type LinkKind } from '../lib/internal-links';
import { useWorkspace } from '../hooks/useWorkspace';

interface Props {
    kind: LinkKind;
    /** The target's key: a video id, a handle. */
    targetKey: string;
    /** A link's time was clicked (a moment in the target video): the video sidebar jumps its player there. Without it,
     *  the times are shown, not clickable. */
    onTime?: (time: string) => void;
    /** How many texts link here, once known (null while loading). */
    onCount?: (count: number | null) => void;
}

/**
 * Backlinks: every text that links to a video or a person (src-tauri/src/db/links.rs's find_backlinks), one row
 * per text, saying where it is, the moments its links start at, and the words around its first link. A row opens
 * where the text lives: the other video, the person, the term. Loaded when shown, so it's always current.
 */
export function BacklinksList({ kind, targetKey, onTime, onCount }: Props) {
    const { labels } = useWorkspace();
    const [rows, setRows] = useState<Backlink[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setRows(null);
        setError(null);
        onCount?.(null);
        getBacklinks(kind, targetKey)
            .then(found => {
                if (cancelled) return;
                setRows(found);
                onCount?.(found.length);
            })
            .catch(e => { if (!cancelled) setError(typeof e === 'string' ? e : 'Couldn\'t look for links.'); });
        return () => { cancelled = true; };
    }, [kind, targetKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const where: Record<Backlink['source'], { label: string; Icon: typeof FileText }> = {
        summary: { label: 'AI Summary', Icon: Sparkles },
        transcript: { label: 'Transcript', Icon: FileText },
        note: { label: 'Notes', Icon: NotebookPen },
        bio: { label: labels.aliasBiography, Icon: UserSearch },
        definition: { label: labels.aliasGlossary, Icon: BookA },
    };
    const open = (row: Backlink) => {
        if (row.videoId) openInternalLink('video', row.videoId);
        else if (row.source === 'bio' && row.key) openInternalLink('bio', row.key);
        else if (row.source === 'definition' && row.key) openInternalLink('glossary', row.key);
    };

    if (error) return <p className="text-[11px] text-red-400 py-2">{error}</p>;
    if (!rows) return <p className="text-[11px] text-[#666666] italic py-2">Looking for links...</p>;
    if (rows.length === 0) {
        return <p className="text-[11px] text-[#666666] italic py-2">Nothing links here yet. Links you add elsewhere show up here.</p>;
    }

    return (
        <div className="space-y-1 max-h-[320px] overflow-y-auto custom-scrollbar pr-1">
            {rows.map((row, i) => {
                const { label, Icon } = where[row.source];
                return (
                    <div
                        key={`${row.source}:${row.videoId ?? row.key}:${i}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => open(row)}
                        onKeyDown={e => { if (e.key === 'Enter') open(row); }}
                        title={`Open ${row.title}`}
                        className="cursor-pointer p-2 rounded-lg hover:bg-white/5 transition-colors"
                    >
                        <div className="flex items-center gap-1.5 min-w-0">
                            <Icon className="w-3 h-3 shrink-0 text-[#888888]" />
                            <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-[#888888]">{label}</span>
                            <span className="text-[#555555] text-[10px]">·</span>
                            <span className="min-w-0 truncate text-[12px] font-semibold text-white">{row.title}</span>
                            {row.links > 1 && <span className="shrink-0 text-[10px] text-[#777777]">{row.links} links</span>}
                        </div>
                        {row.times.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                                {row.times.map(time => onTime ? (
                                    <button
                                        key={time}
                                        type="button"
                                        onClick={e => { e.stopPropagation(); onTime(time); }}
                                        title={`Jump to ${time}`}
                                        className="px-1 rounded font-mono text-[10px] bg-[var(--k-accent)]/15 text-[var(--k-accent)] hover:bg-[var(--k-accent)]/25 transition-colors cursor-pointer"
                                    >
                                        {time}
                                    </button>
                                ) : (
                                    <span key={time} className="px-1 rounded font-mono text-[10px] bg-white/5 text-[#aaaaaa]">{time}</span>
                                ))}
                            </div>
                        )}
                        <p className="mt-1 text-[11px] leading-snug text-[#aaaaaa] line-clamp-2">{row.excerpt}</p>
                    </div>
                );
            })}
        </div>
    );
}
