import { useState, useEffect, useCallback } from 'react';
import { getWdbsTree, getUnsortedVideoCount, type WdbsNode } from '../api';

/**
 * Owns the Warp Drive taxonomy tree's data — the fetched tree, its "Unsorted" count, and which
 * branches are expanded — independent of whether WdbsTreePanel.tsx itself is currently mounted.
 * App.tsx unmounts that panel entirely whenever the user leaves the Library view (its own
 * viewMode switch), and living inside the panel used to mean every *return* to Library re-fetched
 * the whole tree from scratch, even with nothing to actually refetch — expensive (a real Tauri
 * round trip rebuilding the tree from every video's WDBS assignment), and pointless unless a real
 * WDBS edit happened meanwhile, which is exactly what `version` is for (App.tsx's driveVersion).
 * Living up here instead, the fetched data — and which branches were left open — survives a view
 * switch; only `version` actually changing fetches again.
 */
export function useWdbsTree(version: number) {
    const [tree, setTree] = useState<WdbsNode[]>([]);
    const [loading, setLoading] = useState(true);
    const [unsortedCount, setUnsortedCount] = useState(0);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const fetchTree = useCallback(() => {
        let cancelled = false;
        setLoading(true);
        getWdbsTree()
            .then(nodes => { if (!cancelled) setTree(nodes); })
            .catch(() => { if (!cancelled) setTree([]); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => fetchTree(), [fetchTree, version]);

    useEffect(() => {
        let cancelled = false;
        getUnsortedVideoCount().then(c => { if (!cancelled) setUnsortedCount(c); }).catch(() => { if (!cancelled) setUnsortedCount(0); });
        return () => { cancelled = true; };
    }, [version]);

    return { tree, setTree, unsortedCount, loading, expanded, setExpanded };
}
