import { useState, useEffect, useCallback } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { getWdbsTree, type WdbsNode } from '../api';
import { BRAND } from '../branding';

interface WdbsTreePanelProps {
    // `undefined` means nothing is selected; a real path selects that node (and its descendants
    // — see db/wdbs.rs::list_videos_by_wdbs) elsewhere in whatever's consuming the selection.
    selectedPath: string | undefined;
    onSelect: (path: string, label: string) => void;
    className?: string;
}

/**
 * The Warp Drive taxonomy tree UI — built from the distinct WDBS values in use (see
 * db/wdbs.rs::get_wdbs_tree) — shown as a toggleable side panel next to the Library/Portal grid
 * (see App.tsx's Drive panel button). Owns fetching and expand/collapse state; selection itself
 * is controlled by the caller (App.tsx wires it into the Library's own search/filter state).
 */
export function WdbsTreePanel({ selectedPath, onSelect, className }: WdbsTreePanelProps) {
    const [tree, setTree] = useState<WdbsNode[]>([]);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const label = BRAND.driveLabel;

    useEffect(() => {
        let cancelled = false;
        getWdbsTree()
            .then(nodes => { if (!cancelled) setTree(nodes); })
            .catch(() => { if (!cancelled) setTree([]); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, []);

    const toggleExpanded = useCallback((path: string) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path); else next.add(path);
            return next;
        });
    }, []);

    return (
        <div className={className}>
            <h2 className="text-xl font-bold text-white mb-4 px-1">{label}</h2>
            {loading ? (
                <div className="text-center text-gray-500 py-16 bg-[#121212] rounded-xl border border-[#272727]">
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                    <p className="text-sm">Loading {label}...</p>
                </div>
            ) : tree.length === 0 ? (
                <div className="text-center text-gray-500 py-16 bg-[#121212] rounded-xl border border-[#272727] px-4">
                    <p className="text-sm">No videos yet. They'll show up here once tagged with a {label} designator.</p>
                </div>
            ) : (
                <div className="bg-[#121212] rounded-xl border border-[#272727] p-2 space-y-0.5 lg:sticky lg:top-4 lg:max-h-[75vh] lg:overflow-y-auto custom-scrollbar">
                    {tree.map(node => (
                        <TreeBranch
                            key={node.path}
                            node={node}
                            depth={0}
                            expanded={expanded}
                            onToggleExpanded={toggleExpanded}
                            selectedPath={selectedPath}
                            onSelect={onSelect}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function TreeBranch({ node, depth, expanded, onToggleExpanded, selectedPath, onSelect }: {
    node: WdbsNode;
    depth: number;
    expanded: Set<string>;
    onToggleExpanded: (path: string) => void;
    selectedPath: string | undefined;
    onSelect: (path: string, label: string) => void;
}) {
    const isExpanded = expanded.has(node.path);
    const hasChildren = node.children.length > 0;
    return (
        <>
            <TreeRow
                label={node.segment}
                count={node.count}
                depth={depth}
                hasChildren={hasChildren}
                expanded={isExpanded}
                selected={selectedPath === node.path}
                onToggle={() => onToggleExpanded(node.path)}
                onSelect={() => onSelect(node.path, node.segment)}
            />
            {hasChildren && isExpanded && node.children.map(child => (
                <TreeBranch
                    key={child.path}
                    node={child}
                    depth={depth + 1}
                    expanded={expanded}
                    onToggleExpanded={onToggleExpanded}
                    selectedPath={selectedPath}
                    onSelect={onSelect}
                />
            ))}
        </>
    );
}

function TreeRow({ label, count, depth, hasChildren, expanded, selected, onToggle, onSelect }: {
    label: string;
    count: number;
    depth: number;
    hasChildren: boolean;
    expanded: boolean;
    selected: boolean;
    onToggle: () => void;
    onSelect: () => void;
}) {
    return (
        <div
            className={`flex items-center gap-1 rounded-lg cursor-pointer group transition-colors ${selected ? 'bg-red-600 text-white' : 'text-gray-300 hover:bg-[#272727]'}`}
            style={{ paddingLeft: `${depth * 16 + 4}px` }}
            onClick={onSelect}
        >
            <button
                onClick={(e) => { e.stopPropagation(); onToggle(); }}
                className={`p-1.5 shrink-0 rounded transition-colors ${hasChildren ? 'cursor-pointer' : 'invisible'} ${selected ? 'text-white hover:bg-white/20' : 'text-gray-500 hover:text-white hover:bg-white/5'}`}
                tabIndex={hasChildren ? 0 : -1}
            >
                {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
            <span className="flex-1 text-sm py-1.5 truncate">{label}</span>
            <span className={`text-[11px] font-medium px-2 shrink-0 ${selected ? 'text-white/80' : 'text-gray-500'}`}>{count}</span>
        </div>
    );
}
