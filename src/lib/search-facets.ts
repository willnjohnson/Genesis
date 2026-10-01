import type { Facet } from '../components/SearchBar';

/** Which search bar a query belongs to: each mode knows its own facets. */
export type SearchViewMode = 'search' | 'library' | 'glossary' | 'biography';

function facetNames(viewMode: SearchViewMode): string[] {
    return viewMode === 'glossary'
        ? ['term_search', 'definition_search']
        : viewMode === 'biography'
            ? ['person_search', 'bio_search']
            : ['tag_search', 'term_search', 'no_tags', 'video', 'handle', 'channel_name'];
}

// A SearchBar whose query lives outside it (the Library's, the Glossary's, Manage Drive's Unsorted list) is handed its
// own state back as `initialFacets`/`initialQuery`, worked out from the stored query string by these two. The bar
// syncs from them whenever its input isn't focused, so leaving them out resets it: clicking a facet chip (which
// takes focus off the input) would clear the chips and the text.

/** The facet chips in a stored query string. */
export function getLibraryFacets(q: string, viewMode: SearchViewMode): Facet[] {
    if (!q) return [];
    const FACET_RE = new RegExp(`(${facetNames(viewMode).join('|')}):(?:"([^"]*)"|([^ ]*))`, 'g');
    const facets: Facet[] = [];
    let m;
    while ((m = FACET_RE.exec(q)) !== null) {
        facets.push({ type: m[1] as Facet['type'], value: "" });
    }
    return facets;
}

/** The typed text in a stored query string, with its facet prefixes taken out. */
export function getLibraryQuery(q: string, viewMode: SearchViewMode): string {
    if (!q) return '';
    const whitelist = facetNames(viewMode);

    // Check if q starts with a facet prefix and has exactly one colon
    const colonIndex = q.indexOf(':');
    const firstSpaceIndex = q.indexOf(' ');
    // Only treat this as a bare "facetname:value" display-unwrap when what's actually before the
    // colon is one of this mode's known facet names — otherwise a bare leading ':' (a Warp Drive
    // designator, e.g. ":UAP floating" in Library mode — see db/search.rs) would have its colon
    // eaten here even though it isn't a facet at all.
    const isKnownFacetPrefix = colonIndex > 0 && whitelist.includes(q.slice(0, colonIndex));

    if (isKnownFacetPrefix && (firstSpaceIndex === -1 || firstSpaceIndex > colonIndex)) {
        // trimStart: harmless for every other facet here (their value starts right after the
        // colon, no space) but no_tags always has one ("no_tags: foo"), to keep it separate from
        // the free text that follows rather than swallowing it as no_tags' own value.
        const rest = q.slice(colonIndex + 1).trimStart();
        const whitelistPattern = `(${whitelist.join('|')})`;
        if (!new RegExp(`${whitelistPattern}:`).test(rest)) {
            let val = rest;
            if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
            return val;
        }
    }

    const FACET_RE = new RegExp(`(${whitelist.join('|')}):(?:"([^"]*)"|([^ ]*))`, 'g');
    return q.replace(FACET_RE, '');
}
