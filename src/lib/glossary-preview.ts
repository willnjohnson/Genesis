import { getGlossaryTerms, type GlossaryTerm } from '../api';
import { resolveEntry } from './glossary';
import { inlineMarkdown } from './preview-markdown';

// The entries are fetched once and reused for a little while: a preview shouldn't cost a database read every time the
// pointer passes over a link, and a term edited a moment ago is still right after this long.
const KEEP_MS = 20_000;
let cached: { at: number; entries: Promise<GlossaryTerm[]> } | null = null;

function entries(): Promise<GlossaryTerm[]> {
    if (!cached || Date.now() - cached.at > KEEP_MS) {
        const fetched = getGlossaryTerms().then(all => all.filter(t => t.definition.trim() !== ''));
        cached = { at: Date.now(), entries: fetched };
        fetched.catch(() => { cached = null; });
    }
    return cached.entries;
}

/** The term as a link would open it: its name, its definition boiled down to inline markdown for the preview card, and
 *  the definition itself (real markdown, for a copy button) — or null if it isn't in the glossary. */
export async function glossaryPreview(term: string): Promise<{ term: string; markdown: string; raw: string } | null> {
    const found = resolveEntry(await entries(), term);
    return found ? { term: found.term, markdown: inlineMarkdown(found.definition, found.term), raw: found.definition } : null;
}
