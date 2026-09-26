import { useMemo, useState } from 'react';
import { BookA, X } from 'lucide-react';
import type { GlossaryTerm } from '../../api';
import {
    applyMatches, detectGlossaryMatches, findGlossaryLinks, removeLinks,
    type GlossaryLink, type GlossaryMatch,
} from '../../lib/glossary-detect';
import { buildLink } from '../../lib/internal-links';
import { resolveEntry } from '../../lib/glossary';

interface Props {
    /** The text being edited (transcript or summary). */
    text: string;
    /** Every glossary row (a term with its definition and the Drives it's filed under). */
    glossaryTerms: GlossaryTerm[];
    /** The Drives the video is in (":CHEM"): their glossaries are offered first. */
    driveRoots: string[];
    /** Puts the changed text (links added or taken out) back into the editor. */
    onApply: (newText: string) => void;
    /** Moves the editor's selection to a spot in the text, so it can be read in place. */
    onJump: (start: number, end: number) => void;
    /** Opens a term's definition (the entry from the glossary being looked through). Left out, term names aren't clickable. */
    onOpenTerm?: (entry: GlossaryTerm) => void;
    onClose: () => void;
}

const CONTEXT = 32; // characters of the surrounding text shown on each side of a mention

const flat = (s: string) => s.replace(/\s+/g, ' ');

/**
 * The "Detect Glossary" panel for the transcript/summary editors, in two halves.
 *
 * Link: lists every mention of each glossary term in the text (see lib/glossary-detect.ts), grouped by
 * term, each with a checkbox, unticked to start with. A term is linked once, so ticking one of its
 * mentions unticks the others: you choose WHICH mention gets the link. Nothing changes until you
 * choose "Link selected": a mention that only looks like a term (the mineral in "magnesium sulfate")
 * is yours to leave alone.
 *
 * Unlink: lists the glossary links already in the text, so any of them can be taken back out, leaving
 * their words as plain text.
 *
 * Clicking a row's words jumps to it in the editor.
 */
export function GlossaryDetectPanel({ text, glossaryTerms, driveRoots, onApply, onJump, onOpenTerm, onClose }: Props) {
    const [mode, setMode] = useState<'link' | 'unlink'>('link');
    // Ticked rows, by "term@start": positions move when the text does, so a stale tick simply stops matching.
    const [ticked, setTicked] = useState<Set<string>>(new Set());

    // Which glossary to look through: one of the video's own Drives, or the terms filed under no Drive
    // at all ("General"). Never another Drive's: its terms mean something else where this video is. A
    // Quick Tag has no definition, so there's nothing to link it to.
    const withDefinition = useMemo(() => glossaryTerms.filter(r => r.definition.trim() !== ''), [glossaryTerms]);
    const scopes = useMemo(() => {
        const inDrive = (root: string) => new Set(withDefinition.filter(r => r.drives.includes(root)).map(r => r.term));
        const general = new Set(withDefinition.filter(r => r.drives.length === 0).map(r => r.term));
        return [
            ...driveRoots.map(root => ({ id: root, label: root.replace(/^:/, ''), terms: inDrive(root) })),
            { id: '', label: 'No Drive (general)', terms: general },
        ];
    }, [withDefinition, driveRoots]);
    // Starts on the video's own (first) Drive, even when its glossary is empty: the count beside it
    // says so, and the general glossary is one pick away. A video with no Drive starts on General.
    const [scopeId, setScopeId] = useState<string | null>(null);
    const scope = scopes.find(s => s.id === scopeId) ?? scopes[0];

    // A term's name opens its definition from the glossary being looked through: the chosen Drive's, or the
    // general one, since that's the meaning being linked to.
    const termName = (term: string, className: string) => {
        const entry = onOpenTerm ? resolveEntry(withDefinition, term, scope.id ? [scope.id] : []) : undefined;
        if (!entry) return <span className={className}>{term}</span>;
        return (
            <button onClick={() => onOpenTerm?.(entry)} className={`${className} text-left hover:underline cursor-pointer`} title="Open definition">
                {term}
            </button>
        );
    };

    const matches = useMemo(() => detectGlossaryMatches(text, [...scope.terms], { allMentions: true }), [text, scope]);
    const links = useMemo(() => findGlossaryLinks(text), [text]);

    interface Row { key: string; term: string; start: number; end: number; before: string; shown: string; after: string; also: string[] }
    const rows: Row[] = useMemo(() => {
        // A mention can fit several terms that share a plain name ("Magnesium (chem)" and "Magnesium (health)"):
        // each gets its own row at that spot, and each row says which others it competes with.
        const termsAt = new Map<number, string[]>();
        for (const m of matches) termsAt.set(m.start, [...(termsAt.get(m.start) ?? []), m.term]);
        const row = (key: string, term: string, start: number, end: number, shown: string): Row => ({
            key, term, start, end, shown,
            before: flat(text.slice(Math.max(0, start - CONTEXT), start)),
            after: flat(text.slice(end, end + CONTEXT)),
            also: mode === 'link' ? (termsAt.get(start) ?? []).filter(t => t !== term) : [],
        });
        if (mode === 'unlink') return links.map((l: GlossaryLink) => row(`${l.term}@${l.start}`, l.term, l.start, l.end, l.label));
        // Grouped by term — each term's mentions together, in the order they occur, and the terms in the
        // order each first appears — so a term is one heading, not one every time the text comes back to it.
        const order = new Map<string, number>();
        for (const m of matches) if (!order.has(m.term)) order.set(m.term, order.size);
        return matches
            .map((m: GlossaryMatch) => row(`${m.term}@${m.start}`, m.term, m.start, m.end, m.text))
            .sort((a, b) => (order.get(a.term)! - order.get(b.term)!) || a.start - b.start);
    }, [mode, matches, links, text]);

    const chosen = rows.filter(r => ticked.has(r.key));

    const toggle = (keys: string[], on: boolean) =>
        setTicked(prev => {
            const next = new Set(prev);
            for (const k of keys) (on ? next.add(k) : next.delete(k));
            return next;
        });
    // A term gets one link, and a spot gets one term: ticking a mention clears whichever other mention of the
    // term was ticked, and any other term's row at the same spot (the words can only mean one of them).
    const pick = (row: Row, on: boolean) =>
        setTicked(prev => {
            const next = new Set(prev);
            for (const other of rows) if (other.term === row.term || other.start === row.start) next.delete(other.key);
            if (on) next.add(row.key);
            return next;
        });
    // "Select first of each": the first mention of every term (in Link), every link (in Unlink). A mention that could
    // mean more than one term is left for a person to choose, since that's exactly what can't be guessed.
    const selectAll = () => {
        if (mode === 'unlink') { toggle(rows.map(r => r.key), true); return; }
        const firsts = new Map<string, string>();
        for (const r of rows) if (r.also.length === 0 && !firsts.has(r.term)) firsts.set(r.term, r.key);
        setTicked(new Set(firsts.values()));
    };

    const switchMode = (next: 'link' | 'unlink') => {
        setMode(next);
        setTicked(new Set());
    };

    const apply = () => {
        if (chosen.length === 0) return;
        if (mode === 'link') {
            onApply(applyMatches(text, matches.filter(m => ticked.has(`${m.term}@${m.start}`)), m => buildLink(m.text, 'glossary', m.term)));
        } else {
            onApply(removeLinks(text, links.filter(l => ticked.has(`${l.term}@${l.start}`))));
        }
        // Done: the panel closes, leaving the editor with the changed text.
        setTicked(new Set());
        onClose();
    };

    const summary = mode === 'link'
        ? (rows.length === 0 ? 'No unlinked terms found' : `${new Set(rows.map(r => r.term)).size} term${new Set(rows.map(r => r.term)).size === 1 ? '' : 's'} - pick the one mention of each to link`)
        : (rows.length === 0 ? 'No glossary links in this text' : `${rows.length} glossary link${rows.length === 1 ? '' : 's'} - tick the ones to unlink`);

    return (
        <div className="absolute top-4 right-4 max-w-[calc(100%-2rem)] pointer-events-auto z-51 w-96 max-h-[70%] flex flex-col bg-[#1a1a1a] rounded-xl border border-[#303030] shadow-xl animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#303030]">
                <BookA className="w-4 h-4 text-[#aaaaaa] shrink-0" />
                <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold text-white">Detect Glossary</div>
                    <div className="text-[10px] text-[#888888]">{summary}</div>
                </div>
                <button onClick={onClose} className="w-7 h-7 flex items-center justify-center text-[#888888] hover:text-white transition-colors cursor-pointer" title="Close">
                    <X className="w-4 h-4" />
                </button>
            </div>

            <div className="flex items-center gap-1 px-3 pt-2">
                {(['link', 'unlink'] as const).map(m => (
                    <button
                        key={m}
                        onClick={() => switchMode(m)}
                        className={`px-3 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer ${mode === m ? 'bg-blue-600 text-white' : 'bg-[#272727] text-[#aaaaaa] hover:text-white hover:bg-[#3f3f3f]'}`}
                    >
                        {m === 'link' ? 'Link' : `Unlink (${links.length})`}
                    </button>
                ))}
            </div>

            {mode === 'link' && (
                <div className="flex items-center gap-2 px-3 py-2 border-b border-[#303030]">
                    <label htmlFor="glossary-scope" className="text-[10px] font-bold uppercase tracking-wider text-[#888888] shrink-0">Glossary</label>
                    <select
                        id="glossary-scope"
                        value={scope.id}
                        onChange={e => { setScopeId(e.target.value); setTicked(new Set()); }}
                        className="flex-1 min-w-0 h-7 px-2 bg-[#121212] border border-[#303030] hover:border-[#505050] rounded-md text-[11px] text-white outline-none cursor-pointer"
                    >
                        {scopes.map(s => (
                            <option key={s.id || 'general'} value={s.id}>{s.label} ({s.terms.size})</option>
                        ))}
                    </select>
                </div>
            )}

            {rows.length > 0 && (
                <div className={`flex items-center justify-between gap-2 px-3 py-2 border-b border-[#303030] ${mode === 'unlink' ? 'mt-2 border-t' : ''}`}>
                    <div className="flex items-center gap-3 text-[11px]">
                        <button onClick={selectAll} className="text-[#aaaaaa] hover:text-white cursor-pointer">{mode === 'link' ? 'Select First of Each' : 'Select All'}</button>
                        <button onClick={() => setTicked(new Set())} className="text-[#aaaaaa] hover:text-white cursor-pointer">Clear</button>
                    </div>
                    <button
                        onClick={apply}
                        disabled={chosen.length === 0}
                        className="h-7 px-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 text-white text-[9px] font-bold uppercase tracking-widest rounded-md transition-all cursor-pointer active:scale-95"
                    >
                        {mode === 'link' ? 'Link' : 'Unlink'} {chosen.length > 0 ? chosen.length : ''} selected
                    </button>
                </div>
            )}

            <div className="overflow-y-auto custom-scrollbar py-1">
                {rows.map((r, i) => (
                    <div key={r.key}>
                        {/* Link: the term's name once above its mentions (they're grouped). Unlink: a name on every row. */}
                        {mode === 'link' && (i === 0 || rows[i - 1].term !== r.term) && (
                            <div className="flex items-center gap-2 px-3 pt-2 pb-0.5">
                                {termName(r.term, 'text-xs font-semibold text-white truncate')}
                                <span className="text-[10px] text-[#777777] shrink-0">{rows.filter(x => x.term === r.term).length}×</span>
                            </div>
                        )}
                    <div className="flex items-start gap-2 px-3 py-1.5 hover:bg-white/5">
                        <input
                            type="checkbox"
                            checked={ticked.has(r.key)}
                            onChange={e => (mode === 'link' ? pick(r, e.target.checked) : toggle([r.key], e.target.checked))}
                            className="mt-0.5 accent-blue-600 shrink-0"
                            aria-label={`${mode === 'link' ? 'Link' : 'Unlink'} "${r.shown}" ${mode === 'link' ? 'to' : 'from'} ${r.term}`}
                        />
                        <div className="min-w-0">
                            {mode === 'unlink' && <div className="truncate">{termName(r.term, 'text-xs font-semibold text-white truncate')}</div>}
                            <button onClick={() => onJump(r.start, r.end)} className="text-left text-[11px] leading-snug text-[#999999] break-words cursor-pointer" title="Show in the editor">
                                …{r.before}
                                <mark className="bg-blue-500/30 text-white rounded px-0.5">{r.shown}</mark>
                                {r.after}…
                            </button>
                            {r.also.length > 0 && (
                                <div className="text-[10px] text-amber-400/80" title="These words fit more than one term. Pick the one you mean.">
                                    also fits: {r.also.join(', ')}
                                </div>
                            )}
                        </div>
                    </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
