import { Search, AtSign, Youtube, ListVideo, Filter, X, Lightbulb, History, Clock, Type, FileText } from 'lucide-react';
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { addSearchHistory, getSearchHistory, getGlossaryTerms, getSearchSuggestions, type HistoryEntry } from '../api';
import { decodeHtmlEntities } from '../lib/utils';
import { useFlags } from '../hooks/useFlags';
import { useWorkspace } from '../hooks/useWorkspace';

export interface Facet {
    type: SearchFacet;
    value: string;
}

interface Props {
    onSearch: (query: string) => void;
    onLiveFilter?: (query: string) => void;
    loading: boolean;
    placeholder?: string;
    viewMode?: 'search' | 'library' | 'glossary' | 'biography';
    initialFacets?: Facet[];
    initialQuery?: string;
}

/**
 * A backslash in front of one of the characters that would otherwise start a filter (# ^ @ > and the ! shortcuts)
 * makes it an ordinary character: `\@` searches for text with an @ in it and doesn't turn it into a handle
 * chip, and `\\` is a backslash itself. The typed text stays as typed, and the escaping backslash is taken off
 * when the search is run.
 */
function unescapeSpecial(text: string): string {
    return text.replace(/^(\s*)\\([#^@>!\\])/, '$1$2');
}

export type SearchFacet = 'handle' | 'channel_name' | 'playlist' | 'video' | 'title_search' | 'term_search' | 'definition_search' | 'tag_search' | 'person_search' | 'bio_search';

/**
 * Search input with facet detection and mode-specific keyboard shortcuts. Typing (or pasting) a
 * recognizable YouTube URL/handle/video-ID/playlist-ID auto-converts the input into a facet chip
 * (see `handleInput`/`extractHandle`/`extractVideoId`/`extractPlaylistId`); `!`-prefixed shortcuts
 * switch search mode per view (`!n`/`!p` in search mode for title/playlist search, `!g`/`!d` in
 * glossary mode for term/definition search), and in the library `#` starts a Quick Tag search and
 * `^` a glossary term search.
 */
export function SearchBar({ onSearch, onLiveFilter, loading, viewMode = 'search', initialFacets = [], initialQuery = '', placeholder }: Props) {
    const [query, setQuery] = useState(initialQuery);
    const [facets, setFacets] = useState<Facet[]>(initialFacets);
    const [showHistory, setShowHistory] = useState(false);
    // A DB owner can hide the recent-searches dropdown and stop it removing entries (see lib/flags.ts).
    const { flags } = useFlags();
    const { labels } = useWorkspace();
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const userActionRef = useRef(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const isLibrary = viewMode === 'library';
    const isGlossary = viewMode === 'glossary';
    const isBiography = viewMode === 'biography';
    const isLibraryOrGlossary = isLibrary || isGlossary || isBiography;
    // Ghost-text completion: as a value is typed into a filter chip, the rest of the first saved one that starts
    // that way is drawn faintly after it. Tab (or the right arrow at the end) takes it, and Up/Down step through
    // the other ones that fit. Nothing is drawn over the results. What it completes depends on the chip:
    // a Tag or Term (Library) from the glossary, a handle from the saved channels, and a video ID from the
    // saved videos. A handle also says which channel it is (its name) and a video ID which video (its title),
    // in parentheses.
    const [suggestionData, setSuggestionData] = useState<{ tags: string[]; terms: string[]; handles: { handle: string; name: string }[]; channels: { name: string; handle: string }[]; videos: { id: string; title: string }[] }>(
        { tags: [], terms: [], handles: [], channels: [], videos: [] });
    // Library only: Search looks things up on YouTube, so what's saved here isn't what it's after.
    const wantsSuggestions = isLibrary;
    const loadSuggestions = useCallback(() => {
        getGlossaryTerms().then(rows => {
            // A name is a Term when any of its rows (one per Drive) has a definition; otherwise a Quick Tag.
            const isTerm = new Map<string, boolean>();
            for (const r of rows) isTerm.set(r.term, (isTerm.get(r.term) ?? false) || r.definition.trim() !== '');
            const names = [...isTerm.keys()].sort((a, b) => a.localeCompare(b));
            setSuggestionData(d => ({ ...d, tags: names.filter(n => !isTerm.get(n)), terms: names.filter(n => isTerm.get(n)) }));
        }).catch(() => {});
        getSearchSuggestions().then(({ handles, channels, videos }) => setSuggestionData(d => ({ ...d, handles, channels, videos }))).catch(() => {});
    }, []);
    useEffect(() => { if (wantsSuggestions) loadSuggestions(); }, [wantsSuggestions, loadSuggestions]);
    const facetType = facets.length === 1 ? facets[0].type : null;
    const suggestKind = wantsSuggestions && (facetType === 'handle' || facetType === 'video' || (facetType === 'tag_search' || facetType === 'term_search' || facetType === 'channel_name')) ? facetType : null;
    // A * in what's typed stands for any run of characters (`*beast` finds "mrbeast"), so a name that starts
    // with the typed text, or, with a *, fits the pattern from its start. The filter itself reads the * the
    // same way (see star_to_like in db/search.rs).
    const wildcard = query.includes('*');
    const suggestions = useMemo((): { text: string; title?: string }[] => {
        if (!suggestKind || !query || query.startsWith('"')) return [];
        const caseSensitive = suggestKind === 'video'; // IDs are case-sensitive
        const pattern = wildcard
            ? new RegExp('^' + query.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'), caseSensitive ? '' : 'i')
            : null;
        const fits = (name: string) => pattern
            ? pattern.test(name)
            : name.length > query.length && (caseSensitive ? name.startsWith(query) : name.toLowerCase().startsWith(query.toLowerCase()));
        switch (suggestKind) {
            case 'tag_search': return suggestionData.tags.filter(fits).map(text => ({ text }));
            case 'term_search': return suggestionData.terms.filter(fits).map(text => ({ text }));
            case 'handle': return suggestionData.handles.filter(h => fits(h.handle)).map(h => ({ text: h.handle, title: h.name }));
            case 'channel_name': return suggestionData.channels.filter(c => fits(c.name)).map(c => ({ text: c.name, title: c.handle ? `@${c.handle}` : undefined }));
            // IDs are random, so a single character would only be noise.
            case 'video': return query.length < 2 ? [] : suggestionData.videos.filter(v => fits(v.id)).map(v => ({ text: v.id, title: v.title }));
            default: return [];
        }
    }, [suggestKind, query, wildcard, suggestionData]);
    const [suggestionPick, setSuggestionPick] = useState(0);
    useEffect(() => setSuggestionPick(0), [query, suggestKind]);
    const suggestion = suggestions.length > 0 ? suggestions[suggestionPick % suggestions.length] : null;
    // Taking a suggestion sets the box's text from code, which the browser's own undo doesn't know about, so
    // Ctrl+Z (and Ctrl+Y / Ctrl+Shift+Z to redo) is handled here: it puts back what was typed before, as long as
    // the box still holds what the suggestion filled in.
    const undoRef = useRef<{ before: string; after: string } | null>(null);
    const redoRef = useRef<{ before: string; after: string } | null>(null);
    const applySuggestion = (text: string) => {
        userActionRef.current = true;
        undoRef.current = { before: query, after: text };
        redoRef.current = null;
        setQuery(text);
        setMenuTouched(false);
    };
    const acceptSuggestion = () => {
        if (suggestion) applySuggestion(suggestion.text);
    };

    // Holding Shift (a moment, on its own) opens the whole list of what fits, below the bar. Up/Down move
    // through it and letting go of Shift takes the one that was moved to; letting go having chosen nothing
    // just closes it, and so does clicking a row while Shift is still down. The short wait keeps it from
    // flashing open on every capital letter typed, since those hold Shift too.
    const [menuOpen, setMenuOpen] = useState(false);
    const [menuTouched, setMenuTouched] = useState(false);
    const shiftTimerRef = useRef<number | null>(null);
    const cancelShiftTimer = () => {
        if (shiftTimerRef.current !== null) window.clearTimeout(shiftTimerRef.current);
        shiftTimerRef.current = null;
    };
    const closeMenu = () => { cancelShiftTimer(); setMenuOpen(false); setMenuTouched(false); };
    useEffect(() => { if (suggestions.length === 0) closeMenu(); }, [suggestions.length]);
    // With a * there's no ghost text to show (the suggestion doesn't start with what's typed), so the list
    // opens by itself instead, and stays until Esc, the choice, or the * going away. Enter picks the row
    // moved to (with none moved to, it searches what's typed), and so does Tab.
    const [wildcardDismissed, setWildcardDismissed] = useState(false);
    useEffect(() => { setWildcardDismissed(false); setMenuTouched(false); }, [query]);
    const shiftMenu = menuOpen && !wildcard;
    const showMenu = suggestions.length > 0 && (shiftMenu || (wildcard && !wildcardDismissed));
    useEffect(() => cancelShiftTimer, []);
    const menuListRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        // Keep the row moved to in view (by hand, so nothing but the list itself scrolls).
        const list = menuListRef.current;
        const row = list?.querySelector<HTMLElement>('[data-active="true"]');
        if (!list || !row) return;
        if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
        else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }, [suggestionPick, menuTouched, menuOpen]);

    const isFilterSearchActive = facets.some(f => f.type === 'title_search' || f.type === 'term_search' || f.type === 'definition_search');

    // Reset when view mode changes
    useEffect(() => {
        userActionRef.current = false;
        setFacets(initialFacets);
        setQuery(initialQuery);
    }, [viewMode]);

    // Sync with external updates
    useEffect(() => {
        let changed = false;
        const isFocused = document.activeElement === inputRef.current;

        if (!isFocused && initialQuery !== query && initialQuery.trim() !== query.trim()) {
            userActionRef.current = false;
            setQuery(initialQuery);
            changed = true;
        }

        const facetsDiffer = initialFacets.length !== facets.length ||
            initialFacets.some((f, idx) => f.type !== facets[idx]?.type);

        if (facetsDiffer && !isFocused) {
            userActionRef.current = false;
            setFacets(initialFacets);
            changed = true;
        }
    }, [initialQuery, initialFacets]);

    useEffect(() => {
        if (!userActionRef.current) return;

        const fullQuery = facets.map(f => {
            const val = f.value || query;
            const escapedValue = (val.includes(' ') && !val.startsWith('"')) ? `"${val}"` : val;
            return `${f.type}:${escapedValue}`;
        }).join(' ') + (facets.length === 0 ? unescapeSpecial(query) : "");

        if (isLibrary) {
            onSearch(fullQuery);
        } else if (onLiveFilter) {
            onLiveFilter(fullQuery);
        }
        
        // Deliberately not reset here: userActionRef must stay true so this effect keeps firing
        // on the next user-driven facets/query change. The two sync effects above are what reset
        // it to false, and only when an external prop update (not the user) changes query/facets.
    }, [facets, query, isLibrary, onLiveFilter, onSearch]);

    const loadHistory = useCallback(async () => {
        const entries = await getSearchHistory(50);
        setHistory(entries);
    }, []);

    const filteredHistory = useMemo(() => {
        if (!query.trim()) return history;
        const lowQuery = query.toLowerCase();
        return history.filter(entry =>
            entry.search_query.toLowerCase().includes(lowQuery)
        );
    }, [history, query]);
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setShowHistory(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const getFacetIcon = (type: string) => {
        switch (type) {
            case 'handle': return <AtSign className="w-3 h-3" />;
            case 'channel_name': return <span className="text-xs font-bold">@@</span>;
            case 'playlist': return <ListVideo className="w-3 h-3" />;
            case 'video': return <span className="text-xs font-bold">{'>'}</span>;
            case 'definition_search': return <FileText className="w-3 h-3" />;
            case 'title_search':
            case 'term_search': return isLibrary ? <span className="text-xs font-bold">^</span> : <Type className="w-3 h-3" />;
            case 'person_search': return <AtSign className="w-3 h-3" />;
            case 'bio_search': return <FileText className="w-3 h-3" />;
            case 'tag_search': return <span className="text-xs font-bold">#</span>;
            default: return <Filter className="w-3 h-3" />;
        }
    };

    const facetPatterns = useMemo(() => {
        const patterns: Record<string, SearchFacet> = {};
        if (isGlossary) {
            patterns['term_search:'] = 'term_search';
            patterns['definition_search:'] = 'definition_search';
        } else if (isBiography) {
            patterns['person_search:'] = 'person_search';
            patterns['bio_search:'] = 'bio_search';
        } else if (isLibrary) {
            patterns['tag_search:'] = 'tag_search';
            patterns['term_search:'] = 'term_search';
            patterns['handle:'] = 'handle';
            patterns['channel_name:'] = 'channel_name';
            patterns['video:'] = 'video';
        } else {
            patterns['title_search:'] = 'title_search';
            patterns['handle:'] = 'handle';
            patterns['video:'] = 'video';
            patterns['playlist:'] = 'playlist';
        }
        return patterns;
    }, [isLibrary, isGlossary, isBiography]);

    const extractPlaylistId = (val: string) => {
        const match = val.match(/[?&]list=([^#&?]+)/);
        if (match) return match[1];
        if (/^(PL|UU|LL|RD|OLAK5uy_)[a-zA-Z0-9_-]+$/.test(val)) return val;
        return null;
    };

    const extractVideoId = (val: string) => {
        if (val.startsWith('>')) return val.slice(1);
        const match = val.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
        if (match) return match[1];
        if (/^[a-zA-Z0-9_-]{11}$/.test(val) && !val.includes('.') && !val.includes('/')) return val;
        return null;
    };

    const extractHandle = (val: string) => {
        if (val.startsWith('@')) return val.slice(1);
        const match = val.match(/youtube\.com\/(?:c\/|channel\/|@|user\/)([^\/\s?]+)/i);
        if (match) return match[1];
        return null;
    };

    const handleInput = (val: string) => {
        userActionRef.current = true;
        let currentVal = val;
        const lowerVal = val.toLowerCase();

        for (const [prefix, type] of Object.entries(facetPatterns)) {
            const prefixIndex = lowerVal.indexOf(prefix);
            if (prefixIndex !== -1) {
                let afterPrefix = currentVal.slice(prefixIndex + prefix.length);
                
                if (type === 'video') afterPrefix = extractVideoId(afterPrefix) || afterPrefix;
                else if (type === 'playlist') afterPrefix = extractPlaylistId(afterPrefix) || afterPrefix;
                else if (type === 'handle') afterPrefix = extractHandle(afterPrefix) || afterPrefix;

                setFacets([{ type, value: "" }]);
                setQuery(afterPrefix);
                return;
            }
        }

        if (!isGlossary && !isBiography && (facets.length === 0 || (isLibrary && facets.length === 1 && (facets[0].type === 'tag_search' || facets[0].type === 'term_search')))) {
            const handle = extractHandle(val);
            const videoId = extractVideoId(val);
            const playlistId = !isLibrary ? extractPlaylistId(val) : null;
            const tagMatch = val.match(/^#(.+?)#?$/);
            const termMatch = val.match(/^\^(.+?)\^?$/);

            if (tagMatch && isLibrary) {
                setFacets([{ type: 'tag_search', value: '' }]);
                setQuery(tagMatch[1]);
                return;
            } else if (termMatch && isLibrary) {
                setFacets([{ type: 'term_search', value: '' }]);
                setQuery(termMatch[1]);
                return;
            } else if (isLibrary && val.startsWith('@@')) {
                // "@@" is a channel's display name (Library only). Like "@", it stays plain text until something
                // follows it, so a lone "@" or "@@" doesn't start a filter that has nothing in it yet.
                if (val.slice(2).trim()) {
                    setFacets([{ type: 'channel_name', value: "" }]);
                    setQuery(val.slice(2));
                    return;
                }
            } else if (handle && handle.trim() && (val.includes('youtube.com') || val.startsWith('@'))) {
                setFacets([{ type: 'handle', value: "" }]);
                setQuery(handle);
                return;
            } else if (videoId && (val.includes('youtube.com') || val.includes('youtu.be') || val.startsWith('>'))) {
                setFacets([{ type: 'video', value: "" }]);
                setQuery(videoId);
                return;
            } else if (!isLibrary && playlistId && val.includes('list=')) {
                setFacets([{ type: 'playlist', value: "" }]);
                setQuery(playlistId);
                return;
            }
            // Search mode shortcuts: !n → title_search, !p → playlist
            if (!isLibrary) {
                if (val === '!n' || val.startsWith('!n ')) {
                    setFacets([{ type: 'title_search', value: '' }]);
                    setQuery(val.slice(2).trimStart());
                    return;
                }
                if (val === '!p' || val.startsWith('!p ')) {
                    setFacets([{ type: 'playlist', value: '' }]);
                    setQuery(val.slice(2).trimStart());
                    return;
                }
            }
        }
        // Glossary mode shortcuts: !g → term_search, !d → definition_search
        if (isGlossary) {
            if (val === '!g' || val.startsWith('!g ')) {
                setFacets([{ type: 'term_search', value: '' }]);
                setQuery(val.slice(2).trimStart());
                return;
            }
            if (val === '!d' || val.startsWith('!d ')) {
                setFacets([{ type: 'definition_search', value: '' }]);
                setQuery(val.slice(2).trimStart());
                return;
            }
        }
        if (isBiography) {
            if (val === '!b' || val.startsWith('!b ')) {
                setFacets([{ type: 'person_search', value: '' }]);
                setQuery(val.slice(2).trimStart());
                return;
            }
            if (val === '!m' || val.startsWith('!m ')) {
                setFacets([{ type: 'bio_search', value: '' }]);
                setQuery(val.slice(2).trimStart());
                return;
            }
        }
        setQuery(val);
    };

    const handleKeyUp = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== 'Shift') return;
        cancelShiftTimer();
        if (shiftMenu && menuTouched && suggestion) acceptSuggestion();
        closeMenu();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Shift') {
            if (!e.repeat && suggestions.length > 0 && !menuOpen && !wildcard) {
                cancelShiftTimer();
                shiftTimerRef.current = window.setTimeout(() => { setMenuOpen(true); setMenuTouched(false); }, 200);
            }
            return;
        }
        cancelShiftTimer();
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            const key = e.key.toLowerCase();
            const undo = undoRef.current;
            const redo = redoRef.current;
            if (key === 'z' && !e.shiftKey && undo && query === undo.after) {
                e.preventDefault();
                userActionRef.current = true;
                setQuery(undo.before);
                undoRef.current = null;
                redoRef.current = undo;
                return;
            }
            if ((key === 'y' || (key === 'z' && e.shiftKey)) && redo && query === redo.before) {
                e.preventDefault();
                userActionRef.current = true;
                setQuery(redo.after);
                redoRef.current = null;
                undoRef.current = redo;
                return;
            }
        }
        if (showMenu) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                // "Nothing chosen" is a stop above the first row and below the last, so the way back to it is
                // to keep going the same way (Up from the top row, Down from the bottom one).
                const n = suggestions.length;
                const pick = suggestionPick % n;
                if (e.key === 'ArrowDown') {
                    if (!menuTouched) { setSuggestionPick(0); setMenuTouched(true); }
                    else if (pick === n - 1) { setSuggestionPick(0); setMenuTouched(false); }
                    else setSuggestionPick(pick + 1);
                } else {
                    if (!menuTouched) { setSuggestionPick(n - 1); setMenuTouched(true); }
                    else if (pick === 0) setMenuTouched(false);
                    else setSuggestionPick(pick - 1);
                }
                return;
            }
            if (wildcard) {
                if ((e.key === 'Enter' && menuTouched) || (e.key === 'Tab' && !e.shiftKey)) {
                    e.preventDefault();
                    acceptSuggestion();
                    return;
                }
                if (e.key === 'Escape') { setWildcardDismissed(true); return; }
            } else {
                // Anything else typed while the Shift list is open is just typing: the list steps aside.
                closeMenu();
            }
        }
        if (suggestion && !wildcard) {
            const atEnd = e.currentTarget.selectionStart === query.length && e.currentTarget.selectionEnd === query.length;
            if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'ArrowRight' && atEnd)) {
                e.preventDefault();
                acceptSuggestion();
                return;
            }
            if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggestions.length > 1) {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                setSuggestionPick(i => (i + step + suggestions.length) % suggestions.length);
                return;
            }
        }
        if (e.key === 'Backspace' && query === '' && facets.length > 0 && e.currentTarget.selectionStart === 0) {
            userActionRef.current = true;
            const lastFacet = facets[facets.length - 1];
            setFacets(facets.slice(0, -1));
            // A handle chip goes back to the "@" that made it, so one more Backspace clears it.
            setQuery(lastFacet.type === 'handle' ? '@' : lastFacet.type === 'channel_name' ? '@@' : lastFacet.type + ':');
            e.preventDefault();
        }
        if (e.key === 'Escape') {
            setShowHistory(false);
        }
    };

    const removeFacet = (index: number) => {
        userActionRef.current = true;
        setFacets(facets.filter((_, i) => i !== index));
        if (facets.length === 1) setQuery("");
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const isYouTubeMode = !isLibraryOrGlossary && facets.some(f => f.type === 'handle' || f.type === 'video' || f.type === 'playlist');
        if (isFilterSearchActive && !isLibraryOrGlossary && !isYouTubeMode) return;
        // A chip with nothing after it (just typed "@") has nothing to look up.
        if (isYouTubeMode && !query.trim()) return;
        const fullQuery = facets.map(f => `${f.type}:${query}`).join(' ') + (facets.length === 0 ? unescapeSpecial(query) : "");
        const trimmed = fullQuery.trim();
        if (trimmed) {
            onSearch(trimmed);
            const hasOnlyTagSearch = facets.length > 0 && facets.every(f => f.type === 'tag_search' || f.type === 'term_search');
            if (!hasOnlyTagSearch) {
                addSearchHistory(trimmed);
            }
            setShowHistory(false);
        }
    };

    const handleHistorySelect = (entry: HistoryEntry) => {
        userActionRef.current = true;
        setFacets([]);
        handleInput(entry.search_query);
        setShowHistory(false);
        setTimeout(() => {
            onSearch(entry.search_query);
            addSearchHistory(entry.search_query);
        }, 0);
    };

    const handleFocus = () => {
        if (wantsSuggestions) loadSuggestions();
        if (!isLibrary && flags.showSearchHistory) {
            loadHistory();
            setShowHistory(true);
        }
    };

    const [facetMenuIndex, setFacetMenuIndex] = useState<number | null>(null);

    // The order here is the order of the tips list (the lightbulb) above, so the two always read the same.
    const availableFacets = useMemo(() => {
        if (viewMode === 'glossary') {
            return [
                { type: 'term_search' as const, label: 'Term (!g)' },
                { type: 'definition_search' as const, label: 'Definition (!d)' },
            ];
        }
        if (viewMode === 'biography') {
            return [
                { type: 'person_search' as const, label: `${labels.aliasBiographyItem} (!b)` },
                { type: 'bio_search' as const, label: `${labels.aliasBiography} (!m)` },
            ];
        }
        if (viewMode === 'search') {
            return [
                { type: 'title_search' as const, label: 'Title (!n)' },
                { type: 'playlist' as const, label: 'Playlist (!p)' },
                { type: 'video' as const, label: 'Video ID (>)' },
                { type: 'handle' as const, label: 'Channel (@)' },
            ];
        }
        // Library mode
        return [
            { type: 'tag_search' as const, label: 'Tag (#)' },
            { type: 'term_search' as const, label: 'Term (^)' },
            { type: 'video' as const, label: 'Video ID (>)' },
            { type: 'handle' as const, label: 'Handle (@)' },
            { type: 'channel_name' as const, label: 'Channel Name (@@)' },
        ];
    }, [viewMode]);

    const handleFacetChange = (index: number, newType: SearchFacet) => {
        userActionRef.current = true;
        const newFacets = [...facets];
        newFacets[index] = { ...newFacets[index], type: newType };
        setFacets(newFacets);
        setFacetMenuIndex(null);
    };

    // Outside click for facet menu
    useEffect(() => {
        if (facetMenuIndex !== null) {
            const handleClick = (e: MouseEvent) => {
                const target = e.target as HTMLElement;
                if (!target.closest('.facet-menu-container')) {
                    setFacetMenuIndex(null);
                }
            };
            document.addEventListener('click', handleClick);
            return () => document.removeEventListener('click', handleClick);
        }
    }, [facetMenuIndex]);

    return (
        <form onSubmit={handleSubmit} className="w-full mb-2 px-4 relative z-50">
            {/* data-search-bar: the command palette (CommandPalette.tsx) lines itself up with this row. */}
            <div data-search-bar className={`flex items-stretch justify-center transition-all ${loading ? 'opacity-50 pointer-events-none' : ''}`}>
                <div ref={containerRef} className="relative flex-1">
                    <div className={`flex flex-wrap items-center bg-[#121212] border border-[#404040] ${isLibraryOrGlossary ? 'rounded-full' : 'rounded-l-full'} focus-within:ring-1 focus-within:ring-[var(--k-accent)] transition-all min-h-11 py-1 px-3 gap-2`}>
                        {facets.map((f, i) => (
                            <div key={`${f.type}-${i}`} className="relative flex items-center gap-1.5 bg-[#272727] border border-[#444444] text-[#aaaaaa] rounded-full px-3 py-0.5 animate-in zoom-in-95 duration-200 shrink-0 select-none facet-menu-container">
                                <button
                                    type="button"
                                    onClick={() => setFacetMenuIndex(facetMenuIndex === i ? null : i)}
                                    className="flex items-center gap-1.5 hover:text-white transition-colors cursor-pointer group"
                                >
                                    {getFacetIcon(f.type)}
                                    <span className="text-[11px] font-bold uppercase tracking-wider group-hover:underline decoration-dotted transition-all underline-offset-2">{f.type.replace(/_/g, ' ')}</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => removeFacet(i)}
                                    className="hover:text-red-500 transition-colors ml-1"
                                >
                                    <X className="w-3 h-3" />
                                </button>

                                {facetMenuIndex === i && (
                                    <div className="absolute top-full left-0 mt-2 w-48 bg-[#1a1a1a] border border-[#333] rounded-xl overflow-hidden z-[100] animate-in fade-in slide-in-from-top-1 duration-200">
                                        <div className="p-2 border-b border-[#333] bg-[#222]">
                                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest px-2">Change Filter</span>
                                        </div>
                                        <div className="max-h-60 overflow-y-auto">
                                            {availableFacets.map((af) => (
                                                <button
                                                    key={af.type}
                                                    type="button"
                                                    onClick={() => handleFacetChange(i, af.type)}
                                                    className={`w-full text-left px-3 py-2 text-[11px] font-semibold transition-colors flex items-center justify-between group ${f.type === af.type ? 'text-[var(--k-accent)] bg-[color-mix(in_srgb,var(--k-accent)_5%,transparent)] cursor-default' : 'text-gray-400 hover:text-white hover:bg-[#2a2a2a] cursor-pointer'}`}
                                                >
                                                    <div className="flex items-center gap-2">
                                                        {getFacetIcon(af.type)}
                                                        {af.label}
                                                    </div>
                                                    {f.type === af.type && <div className="w-1.5 h-1.5 rounded-full bg-[var(--k-accent)]" />}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}

                        <div className="relative flex-1 min-w-[120px]">
                            <input
                                ref={inputRef}
                                type="text"
                                value={query}
                                onChange={(e) => handleInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                onKeyUp={handleKeyUp}
                                onBlur={closeMenu}
                                onFocus={handleFocus}
                                placeholder={(query || facets.length > 0) ? "" : (placeholder || "Search YouTube handle, playlist URL, or video URL")}
                                className="w-full bg-transparent text-white px-2 focus:outline-none placeholder-gray-500 text-[16px] h-full"
                                disabled={loading}
                            />
                            {/* The rest of the suggested value, faint, right after what's typed (the typed part is only
                                there to push it along, so it's invisible). A video ID adds its title, and a handle its channel name, in parentheses,
                                cut short with an ellipsis when it doesn't fit. */}
                            {suggestion && !wildcard && (
                                <div aria-hidden className="absolute inset-0 flex items-center px-2 text-[16px] pointer-events-none whitespace-pre overflow-hidden">
                                    <span className="invisible shrink-0">{query}</span>
                                    <span className="text-gray-500 shrink-0">{suggestion.text.slice(query.length)}</span>
                                    <span className="ml-2 px-1 rounded border border-[#444444] text-[10px] leading-4 text-gray-500 shrink-0">TAB</span>
                                    {suggestion.title && (
                                        <span className="ml-2 min-w-0 flex text-gray-500">
                                            <span>(</span>
                                            <span className="truncate">{suggestion.title}</span>
                                            <span>)</span>
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>

                         {/* Hints Lightbulb */}
                        {!isBiography && (
                            <div className="group/hint relative flex items-center pr-1">
                                <Lightbulb className="w-4 h-4 text-gray-500 hover:text-orange-400 transition-colors cursor-help" />

                                <div className="absolute top-full right-0 mt-3 w-80 bg-[#1a1a1a] border border-[#333] rounded-xl p-4 opacity-0 translate-y-2 pointer-events-none group-hover/hint:opacity-100 group-hover/hint:translate-y-0 transition-all duration-200 z-[100]">
                                    <h4 className="text-[11px] font-bold text-gray-500 uppercase tracking-widest mb-3 border-b border-[#333] pb-2">{labels.aliasSearch} Tips</h4>
                                <div className="space-y-4">
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[10px] text-gray-500 font-bold uppercase tracking-tighter">{isGlossary ? `${labels.aliasGlossary} Mode` : isLibrary ? `${labels.aliasLibrary} Mode` : "Paste Mode"}</span>
                                        <p className="text-[12px] text-gray-300">
                                            {isGlossary ? "Filter your glossary terms." : isLibrary ? "Filter your saved videos using facets." : "Paste any YouTube URL directly into the search bar."}
                                        </p>
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[10px] text-gray-500 font-bold uppercase tracking-tighter">Facet Options</span>
                                        <div className="grid grid-cols-1 gap-1.5 pt-1 text-[11px]">
                                            {isGlossary ? (
                                                <>
                                                    <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                        <span>term_search:</span>
                                                        <span className="text-gray-500 group-hover/code:text-gray-300"><span className="text-orange-400 font-bold mr-1">!g</span>/ Term Filter</span>
                                                    </code>
                                                    <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                        <span>definition_search:</span>
                                                        <span className="text-gray-500 group-hover/code:text-gray-300"><span className="text-orange-400 font-bold mr-1">!d</span>/ Definition Filter</span>
                                                    </code>
                                                </>
                                            ) : isLibrary ? (
                                                <>
                                                    <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                        <span>tag_search:</span>
                                                        <span className="text-gray-500 group-hover/code:text-gray-300"><span className="text-orange-400 font-bold mr-1">#</span>/ Tags</span>
                                                    </code>
                                                    <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                        <span>term_search:</span>
                                                        <span className="text-gray-500 group-hover/code:text-gray-300"><span className="text-orange-400 font-bold mr-1">^</span>/ Terms</span>
                                                    </code>
                                                </>
                                            ) : (
                                                <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                    <span>title_search:</span>
                                                    <span className="text-gray-500 group-hover/code:text-gray-300"><span className="text-orange-400 font-bold mr-1">!n</span>/ Title Filter</span>
                                                </code>
                                            )}
                                            {!isLibraryOrGlossary && (
                                                <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                    <span>playlist:</span>
                                                    <span className="text-gray-500 group-hover/code:text-gray-300"><span className="text-orange-400 font-bold mr-1">!p</span>/ ID / URL</span>
                                                </code>
                                            )}
                                            {!isGlossary && (
                                                <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                    <span>video:</span>
                                                    <span className="text-gray-500 group-hover/code:text-gray-300"><span className="text-orange-400 font-bold mr-1">{'>'}</span>/ ID / URL</span>
                                                </code>
                                            )}
                                            {!isGlossary && (
                                                <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                    <span>handle:</span>
                                                    <span className="text-gray-500 group-hover/code:text-gray-300"><span className="text-orange-400 font-bold mr-1">@</span>/ ID / URL</span>
                                                </code>
                                            )}
                                            {isLibrary && (
                                                <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                    <span>channel_name:</span>
                                                    <span className="text-gray-500 group-hover/code:text-gray-300"><span className="text-orange-400 font-bold mr-1">@@</span>/ Channel Name</span>
                                                </code>
                                            )}
                                        </div>
                                    </div>

                                 </div>
                            </div>
                        </div>
                        )}
                    </div>

                    {/* Every value that fits, while Shift is held (see menuOpen above). */}
                    {showMenu && (
                        <div className="absolute top-full left-0 right-0 mt-1.5 bg-[#141414] border border-[#303030] rounded-xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
                            <div ref={menuListRef} className="max-h-64 overflow-y-auto custom-scrollbar py-1 relative">
                                {suggestions.map((sug, i) => {
                                    const active = menuTouched && i === suggestionPick % suggestions.length;
                                    return (
                                        <div
                                            key={sug.text}
                                            data-active={active}
                                            // Keeps focus in the search box, so Shift being let go is still seen there.
                                            onMouseDown={(e) => e.preventDefault()}
                                            onClick={() => { applySuggestion(sug.text); closeMenu(); }}
                                            className={`flex items-center justify-between gap-4 px-4 py-2 text-[14px] cursor-pointer transition-colors ${active ? 'bg-[#272727] text-white' : 'text-gray-300 hover:bg-[#1f1f1f]'}`}
                                        >
                                            <span className="shrink-0">
                                                {wildcard ? <span className="text-gray-200">{sug.text}</span> : (
                                                    <>
                                                        <span className="text-white font-semibold">{sug.text.slice(0, query.length)}</span>
                                                        <span className="text-gray-400">{sug.text.slice(query.length)}</span>
                                                    </>
                                                )}
                                            </span>
                                            {sug.title && <span className="min-w-0 truncate text-[12px] text-gray-500">{sug.title}</span>}
                                        </div>
                                    );
                                })}
                            </div>
                            {/* The same footer as the command palette's. Past either end of the list clears the choice. */}
                            <div className="flex items-center gap-4 px-4 py-2 border-t border-[#303030] text-[10px] text-gray-600">
                                <span title="Past either end of the list clears the choice"><kbd className="text-gray-400">↑↓</kbd> Move</span>
                                {wildcard
                                    ? <span><kbd className="text-gray-400">Enter</kbd> Select</span>
                                    : <span><kbd className="text-gray-400">Shift</kbd> Release to select</span>}
                                <span className="ml-auto">Suggestions</span>
                            </div>
                        </div>
                    )}

                    {/* Search History Dropdown */}
                    {flags.showSearchHistory && showHistory && !isLibraryOrGlossary && filteredHistory.length > 0 && (
                        <div className="absolute top-full left-0 right-0 mt-1.5 bg-[#141414] border border-[#303030] rounded-xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
                            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#272727]">
                                <History className="w-3.5 h-3.5 text-[#666]" />
                                <span className="text-[11px] font-bold text-[#555] uppercase tracking-widest">Recent Searches</span>
                            </div>
                            <ul className="max-h-72 overflow-y-auto">
                                {filteredHistory.map((entry) => (
                                    <li key={entry.id} className="flex items-center group hover:bg-white/5 transition-colors">
                                        <button
                                            type="button"
                                            onClick={() => handleHistorySelect(entry)}
                                            className="flex items-center gap-3 px-4 py-2.5 text-left flex-1 min-w-0"
                                        >
                                            <Clock className="w-3.5 h-3.5 text-[#555] shrink-0 group-hover:text-[#888] transition-colors" />
                                            <span className="text-sm text-[#aaaaaa] group-hover:text-white transition-colors truncate flex-1">
                                                {decodeHtmlEntities(entry.search_query)}
                                            </span>
                                            <span className="text-[10px] text-[#444] shrink-0 ml-2">
                                                {new Date(entry.searchedAt).toLocaleDateString()}
                                            </span>
                                        </button>
                                        {flags.allowClearHistory && (
                                        <button
                                            type="button"
                                            onClick={async (e) => {
                                                e.stopPropagation();
                                                const { deleteHistoryEntry: del } = await import('../api');
                                                await del(entry.id);
                                                setHistory(prev => prev.filter(h => h.id !== entry.id));
                                            }}
                                            className="pr-3 pl-1 py-2.5 text-[#444] hover:text-red-500 transition-colors cursor-pointer shrink-0"
                                            title="Remove from history"
                                        >
                                            <X className="w-3.5 h-3.5" />
                                        </button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
                {!isLibraryOrGlossary && (
                    <button
                        type="submit"
                        disabled={loading || (query.trim() === '' && facets.length === 0)}
                        className="flex items-center justify-center px-6 bg-[#222222] border border-[#404040] border-l-0 rounded-r-full transition-colors disabled:opacity-50 group h-auto min-h-11 hover:bg-[#444444] hover:border-[#505050] cursor-pointer"
                        title={labels.aliasSearch}
                    >
                        <Search className="w-5 h-5 text-[#aaaaaa] group-hover:text-white" />
                    </button>
                )}
            </div>
        </form>
    );
}
