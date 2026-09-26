/**
 * Finds places in a piece of markdown where a glossary term is mentioned, so the editor can offer to
 * turn them into links. It only ever SUGGESTS: whether "magnesium" in a transcript means the
 * Magnesium you defined (rather than magnesium sulfate, say) takes a person to judge.
 *
 * A term is looked for by its full name and also by its name without a trailing qualifier: "MRI Scan
 * (Magnetic Resonance Imaging)" is found where the text says "MRI Scan", and "Magnesium (chem)" where it
 * says "magnesium", because nobody writes the qualifier out. When several terms share that plain name
 * ("Magnesium (chem)" and "Magnesium (health)") the mention is returned once for each of them, and the
 * caller decides which meaning it is; the link is still made to the full term name.
 *
 * Rules: whole words only, ignoring case; a longer term wins over a shorter one at the same spot
 * ("magnesium sulfate" over "magnesium"); nothing inside a heading, code, an existing link, an image
 * or a URL;
 * no two suggestions overlap; and none at all for a term the text already links somewhere. By default
 * only the FIRST mention of each term is returned (a term doesn't need linking every time it comes
 * up); with `allMentions` every mention is, for a caller that lets a person pick which one to link.
 */

export interface GlossaryMatch {
    /** The term as it's named in the glossary. */
    term: string;
    /** Where the mention is in the text, and exactly what it says there (its own capitalization). */
    start: number;
    end: number;
    text: string;
}

// Text a suggestion must never land in: headings (a title isn't linked), fenced and inline code,
// images and links (their labels too, since those are already links), autolinks and bare URLs.
const PROTECTED: RegExp[] = [
    /^ {0,3}#{1,6}(?:[ \t].*)?$/gm,
    /```[\s\S]*?```/g,
    /`[^`\n]*`/g,
    /!?\[[^\]]*\]\([^)]*\)/g,
    /<https?:\/\/[^>\s]+>/g,
    /https?:\/\/[^\s)<>\]]+/g,
];

function protectedRanges(text: string): [number, number][] {
    const ranges: [number, number][] = [];
    for (const pattern of PROTECTED) {
        for (const m of text.matchAll(pattern)) ranges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    }
    return ranges.sort((a, b) => a[0] - b[0]);
}

const normalizeName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

/** A name without its trailing qualifier: "MRI Scan (Magnetic Resonance Imaging)" -> "MRI Scan". */
export function baseName(name: string): string {
    return name.replace(/\s*\([^()]*\)\s*$/, '').trim();
}
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function detectGlossaryMatches(text: string, terms: readonly string[], options: { allMentions?: boolean } = {}): GlossaryMatch[] {
    // Every phrase to look for -> the terms it can mean: each term's full name, and its name without a
    // trailing qualifier, when that differs.
    const phrases = new Map<string, string[]>();
    const add = (phrase: string, term: string) => {
        const key = normalizeName(phrase);
        if (key.length < 2) return;
        const list = phrases.get(key);
        if (!list) phrases.set(key, [term]);
        else if (!list.includes(term)) list.push(term);
    };
    for (const t of terms) {
        add(t, t);
        const base = baseName(t);
        if (base !== t.trim()) add(base, t);
    }
    if (phrases.size === 0 || !text) return [];

    // One pass over the text with every phrase as an alternative, longest first: at any spot the regex
    // takes the first alternative that fits, so the longer one beats the shorter one it contains.
    const alternatives = [...phrases.keys()]
        .sort((a, b) => b.length - a.length || a.localeCompare(b))
        .map(k => escapeRegExp(k).replace(/ /g, '\\s+'));
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'giu');

    const blocked = protectedRanges(text);
    // Terms the text already links to: their first mention is taken care of.
    const alreadyLinked = new Set<string>();
    for (const m of text.matchAll(/kinesis:\/\/glossary\/([^)\s]+)/g)) {
        try { alreadyLinked.add(normalizeName(decodeURIComponent(m[1]))); } catch { /* not a term link */ }
    }
    const done = new Set<string>(alreadyLinked);
    const found: GlossaryMatch[] = [];
    let next = 0; // blocked ranges before this are behind the scan
    for (const m of text.matchAll(pattern)) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        while (next < blocked.length && blocked[next][1] <= start) next++;
        const inside = blocked.slice(next).some(([s, e]) => s < end && e > start);
        if (inside) continue;
        const candidates = phrases.get(normalizeName(m[0]));
        if (!candidates) continue;
        for (const term of candidates) {
            const termKey = normalizeName(term);
            if (done.has(termKey)) continue;
            if (!options.allMentions) done.add(termKey);
            found.push({ term, start, end, text: m[0] });
        }
    }
    return found;
}

/** The text with the chosen mentions replaced by `link(match)` (say, a markdown link). */
export function applyMatches(text: string, chosen: readonly GlossaryMatch[], link: (match: GlossaryMatch) => string): string {
    let out = text;
    // From the end, so earlier positions stay valid while later text changes length.
    for (const m of [...chosen].sort((a, b) => b.start - a.start)) {
        out = out.slice(0, m.start) + link(m) + out.slice(m.end);
    }
    return out;
}

/** A glossary link already in the text: `[label](kinesis://glossary/Term)`. */
export interface GlossaryLink {
    term: string;
    /** What the link says (its visible text). */
    label: string;
    /** The whole `[label](...)`, where it is in the text. */
    start: number;
    end: number;
}

/** Every glossary link in the text, except ones that are only shown as code. */
export function findGlossaryLinks(text: string): GlossaryLink[] {
    const code = protectedRanges(text).filter(([s, e]) => /^`/.test(text.slice(s, e)));
    const links: GlossaryLink[] = [];
    for (const m of text.matchAll(/\[([^\]]*)\]\(kinesis:\/\/glossary\/([^)\s]+)\)/g)) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        if (code.some(([s, e]) => s < end && e > start)) continue;
        let term: string;
        try { term = decodeURIComponent(m[2]); } catch { continue; }
        links.push({ term, label: m[1], start, end });
    }
    return links;
}

/** The text with the chosen links taken out, leaving their visible words behind. */
export function removeLinks(text: string, chosen: readonly GlossaryLink[]): string {
    let out = text;
    for (const l of [...chosen].sort((a, b) => b.start - a.start)) {
        out = out.slice(0, l.start) + l.label + out.slice(l.end);
    }
    return out;
}
