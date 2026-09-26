import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronRight, ChevronDown, Inbox } from 'lucide-react';
import { getWdbsTree, setWdbsAlias, setWdbsIcon, getUnsortedVideoCount, UNSORTED_WDBS_FILTER, type WdbsNode } from '../api';
import { useWorkspace } from '../hooks/useWorkspace';
import { WdbsAliasMenu } from './WdbsAliasMenu';
import { WdbsIconMenu } from './WdbsIconMenu';
import { getWdbsIconComponent } from '../lib/wdbs-icons';

interface WdbsTreePanelProps {
    // `undefined` means nothing is selected; a real path selects that node (and its descendants
    // — see db/wdbs.rs::list_videos_by_wdbs) elsewhere in whatever's consuming the selection.
    selectedPath: string | undefined;
    // `alias` is the node's own curated alias (null when it doesn't have one) — the caller shows
    // it alongside the path/label, e.g. App.tsx's "Drive: X (alias)" bottom-bar chip, rather than
    // this panel rendering its own alias display (it used to, directly below the tree; removed in
    // favor of that one shared spot).
    onSelect: (path: string, label: string, alias: string | null) => void;
    className?: string;
    // Bumped by the caller (App.tsx) whenever a video's WDBS assignment or symlinks change
    // elsewhere (Sidebar's editor, bulk assign) so the tree's counts stay in sync — those
    // mutations happen outside this component, so it has no way to know about them on its own.
    // Only added to the fetch effect's dependencies, not used as a remount `key`, so expand/
    // collapse state survives a refresh.
    refreshKey?: number;
    // Gates the right-click "Edit Alias"/"Edit Icon" menu, same settings flag (allowEditWDBS)
    // that gates Bulk Assign Mode and the Sidebar's Warp Drive editor — see App.tsx.
    allowEditAlias?: boolean;
}

/** The paths of the nodes above `path` (root first), or null when `path` isn't in the tree. */
function ancestorPaths(nodes: WdbsNode[], path: string, trail: string[] = []): string[] | null {
    for (const node of nodes) {
        if (node.path === path) return trail;
        const found = ancestorPaths(node.children, path, [...trail, node.path]);
        if (found) return found;
    }
    return null;
}

// The right-click menu itself — just picks which editor (WdbsAliasMenu/WdbsIconMenu) to open next,
// so it's a plain two-row list rather than its own separate component file.
function NodeContextMenu({ x, y, onEditAlias, onEditIcon, onClose }: {
    x: number;
    y: number;
    onEditAlias: () => void;
    onEditIcon: () => void;
    onClose: () => void;
}) {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    const MENU_WIDTH = 160;
    const left = Math.min(x, window.innerWidth - MENU_WIDTH - 12);
    const top = Math.min(y, window.innerHeight - 96);

    return (
        <div
            ref={containerRef}
            style={{ left, top, width: MENU_WIDTH }}
            className="fixed z-[200] bg-[#1a1a1a] border border-[#333] rounded-xl shadow-2xl py-1 animate-in fade-in zoom-in-95 duration-150"
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        >
            <button onClick={onEditAlias} className="w-full text-left px-3 py-2 text-xs text-gray-200 hover:bg-[#272727] cursor-pointer">
                Edit Alias
            </button>
            <button onClick={onEditIcon} className="w-full text-left px-3 py-2 text-xs text-gray-200 hover:bg-[#272727] cursor-pointer">
                Edit Icon
            </button>
        </div>
    );
}

/**
 * The Warp Drive taxonomy tree UI — built from the distinct WDBS values in use (see
 * db/wdbs.rs::get_wdbs_tree) — shown as a toggleable side panel next to the Library/Portal grid
 * (see App.tsx's Drive panel button). Owns fetching and expand/collapse state; selection itself
 * is controlled by the caller (App.tsx wires it into the Library's own search/filter state).
 */
export function WdbsTreePanel({ selectedPath, onSelect, className, refreshKey, allowEditAlias = false }: WdbsTreePanelProps) {
    const [tree, setTree] = useState<WdbsNode[]>([]);
    const [loading, setLoading] = useState(true);
    // The synthetic "Unsorted" entry's count (see UnsortedRow below) — videos with no home Warp
    // Drive at all, not a real taxonomy node so it isn't part of `tree`. Refetched on the same
    // trigger as the tree itself, since a video landing here or leaving is exactly the kind of
    // WDBS-assignment change refreshKey already exists to catch.
    const [unsortedCount, setUnsortedCount] = useState(0);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: WdbsNode } | null>(null);
    const [aliasMenu, setAliasMenu] = useState<{ x: number; y: number; path: string; segment: string; alias: string } | null>(null);
    const [savingAlias, setSavingAlias] = useState(false);
    const [aliasError, setAliasError] = useState<string | null>(null);
    const [iconMenu, setIconMenu] = useState<{ x: number; y: number; path: string; segment: string; icon: string | null } | null>(null);
    const [savingIcon, setSavingIcon] = useState(false);
    const [iconError, setIconError] = useState<string | null>(null);
    const label = useWorkspace().labels.aliasDriveName;

    const fetchTree = useCallback(() => {
        let cancelled = false;
        setLoading(true);
        getWdbsTree()
            .then(nodes => { if (!cancelled) setTree(nodes); })
            .catch(() => { if (!cancelled) setTree([]); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => fetchTree(), [fetchTree, refreshKey]);

    useEffect(() => {
        let cancelled = false;
        getUnsortedVideoCount().then(c => { if (!cancelled) setUnsortedCount(c); }).catch(() => { if (!cancelled) setUnsortedCount(0); });
        return () => { cancelled = true; };
    }, [refreshKey]);

    // A selection made from outside the tree (e.g. a Biography's "In Drive" list) may sit inside
    // collapsed branches, so open the ones above it.
    useEffect(() => {
        if (!selectedPath || tree.length === 0) return;
        const trail = ancestorPaths(tree, selectedPath);
        if (!trail || trail.length === 0) return;
        setExpanded(prev => (trail.every(p => prev.has(p)) ? prev : new Set([...prev, ...trail])));
    }, [selectedPath, tree]);

    const toggleExpanded = useCallback((path: string) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path); else next.add(path);
            return next;
        });
    }, []);

    const handleContextMenu = useCallback((node: WdbsNode, x: number, y: number) => {
        if (!allowEditAlias) return;
        setContextMenu({ x, y, node });
    }, [allowEditAlias]);

    const handleSaveAlias = useCallback(async (alias: string) => {
        if (!aliasMenu) return;
        setSavingAlias(true);
        setAliasError(null);
        try {
            await setWdbsAlias(aliasMenu.path, alias);
            setAliasMenu(null);
            fetchTree();
        } catch (e: any) {
            setAliasError(typeof e === "string" ? e : e?.message ?? "Couldn't save that alias.");
        } finally {
            setSavingAlias(false);
        }
    }, [aliasMenu, fetchTree]);

    const handleSelectIcon = useCallback(async (icon: string) => {
        if (!iconMenu) return;
        setSavingIcon(true);
        setIconError(null);
        try {
            await setWdbsIcon(iconMenu.path, icon);
            setIconMenu(null);
            fetchTree();
        } catch (e: any) {
            setIconError(typeof e === "string" ? e : e?.message ?? "Couldn't save that icon.");
        } finally {
            setSavingIcon(false);
        }
    }, [iconMenu, fetchTree]);

    return (
        <div className={className}>
            {/* shrink-0: stays visible above the tree's own scroll below, same as every other
                view's heading (see VideoList.tsx/GlossaryView.tsx/BiographyView.tsx). */}
            <h2 className="shrink-0 flex items-center min-h-9 text-xl font-bold text-white mb-4 px-1">{label}</h2>
            {/* This panel gets its own independent scroll (App.tsx no longer shares
                scrollContainerRef with it) — scrolling the video grid shouldn't move the Drive
                tree, and vice versa. */}
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                {loading ? (
                    <div className="text-center text-gray-500 py-16 bg-[#121212] rounded-xl border border-[#272727]">
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                        <p className="text-sm">Loading {label}...</p>
                    </div>
                ) : tree.length === 0 && unsortedCount === 0 ? (
                    <div className="text-center text-gray-500 py-16 bg-[#121212] rounded-xl border border-[#272727] px-4">
                        <p className="text-sm">No videos yet. They'll show up here once tagged with a {label} designator.</p>
                    </div>
                ) : (
                    <div className="bg-[#121212] rounded-xl border border-[#272727] p-2 space-y-0.5">
                        {unsortedCount > 0 && (
                            <>
                                <UnsortedRow
                                    count={unsortedCount}
                                    selected={selectedPath === UNSORTED_WDBS_FILTER}
                                    onSelect={() => onSelect(UNSORTED_WDBS_FILTER, 'Unsorted', null)}
                                />
                                {tree.length > 0 && <div className="my-1 border-t border-[#272727]" />}
                            </>
                        )}
                        {tree.map(node => (
                            <TreeBranch
                                key={node.path}
                                node={node}
                                depth={0}
                                expanded={expanded}
                                onToggleExpanded={toggleExpanded}
                                selectedPath={selectedPath}
                                onSelect={onSelect}
                                allowEditAlias={allowEditAlias}
                                onContextMenu={handleContextMenu}
                            />
                        ))}
                    </div>
                )}
            </div>
            {contextMenu && (
                <NodeContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    onEditAlias={() => {
                        setAliasError(null);
                        setAliasMenu({ x: contextMenu.x, y: contextMenu.y, path: contextMenu.node.path, segment: contextMenu.node.segment, alias: contextMenu.node.alias ?? '' });
                        setContextMenu(null);
                    }}
                    onEditIcon={() => {
                        setIconError(null);
                        setIconMenu({ x: contextMenu.x, y: contextMenu.y, path: contextMenu.node.path, segment: contextMenu.node.segment, icon: contextMenu.node.icon });
                        setContextMenu(null);
                    }}
                    onClose={() => setContextMenu(null)}
                />
            )}
            {aliasMenu && (
                <WdbsAliasMenu
                    x={aliasMenu.x}
                    y={aliasMenu.y}
                    segment={aliasMenu.segment}
                    initialAlias={aliasMenu.alias}
                    onSave={handleSaveAlias}
                    onClose={() => setAliasMenu(null)}
                    saving={savingAlias}
                    error={aliasError}
                />
            )}
            {iconMenu && (
                <WdbsIconMenu
                    x={iconMenu.x}
                    y={iconMenu.y}
                    segment={iconMenu.segment}
                    currentIcon={iconMenu.icon}
                    onSelect={handleSelectIcon}
                    onClose={() => setIconMenu(null)}
                    saving={savingIcon}
                    error={iconError}
                />
            )}
        </div>
    );
}

function TreeBranch({ node, depth, expanded, onToggleExpanded, selectedPath, onSelect, allowEditAlias, onContextMenu }: {
    node: WdbsNode;
    depth: number;
    expanded: Set<string>;
    onToggleExpanded: (path: string) => void;
    selectedPath: string | undefined;
    onSelect: (path: string, label: string, alias: string | null) => void;
    allowEditAlias: boolean;
    onContextMenu: (node: WdbsNode, x: number, y: number) => void;
}) {
    const isExpanded = expanded.has(node.path);
    const hasChildren = node.children.length > 0;
    return (
        <>
            <TreeRow
                label={node.segment}
                alias={node.alias}
                icon={node.icon}
                count={node.count}
                depth={depth}
                hasChildren={hasChildren}
                expanded={isExpanded}
                selected={selectedPath === node.path}
                editable={allowEditAlias}
                onToggle={() => onToggleExpanded(node.path)}
                onSelect={() => onSelect(node.path, node.segment, node.alias)}
                onContextMenu={(x, y) => onContextMenu(node, x, y)}
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
                    allowEditAlias={allowEditAlias}
                    onContextMenu={onContextMenu}
                />
            ))}
        </>
    );
}

// The tree's synthetic entry for videos with no home Warp Drive at all (see
// db::count_unsorted_videos/list_unsorted_videos) — rendered above the real taxonomy, not part of
// `tree` itself, so it has none of TreeRow's expand/context-menu/alias machinery: it can't have
// children and there's nothing about it to curate.
function UnsortedRow({ count, selected, onSelect }: { count: number; selected: boolean; onSelect: () => void }) {
    return (
        <div
            className={`flex items-center gap-1 rounded-lg cursor-pointer group transition-colors ${selected ? 'bg-red-600 text-white' : 'text-gray-300 hover:bg-[#272727]'}`}
            style={{ paddingLeft: '4px' }}
            onClick={onSelect}
        >
            {/* Invisible spacer matching TreeRow's toggle button, so the icon/label line up with every real node's. */}
            <span className="p-1.5 shrink-0 invisible"><ChevronRight className="w-3.5 h-3.5" /></span>
            <Inbox className={`w-3.5 h-3.5 shrink-0 mr-1 ${selected ? 'text-white/80' : 'text-gray-500'}`} />
            <span className="flex-1 min-w-0 text-sm py-1.5 truncate italic">Unsorted</span>
            <span className={`text-[11px] font-medium px-2 shrink-0 ${selected ? 'text-white/80' : 'text-gray-500'}`}>{count}</span>
        </div>
    );
}

function TreeRow({ label, alias, icon, count, depth, hasChildren, expanded, selected, editable, onToggle, onSelect, onContextMenu }: {
    label: string;
    alias: string | null;
    icon: string | null;
    count: number;
    depth: number;
    hasChildren: boolean;
    expanded: boolean;
    selected: boolean;
    editable: boolean;
    onToggle: () => void;
    onSelect: () => void;
    onContextMenu: (x: number, y: number) => void;
}) {
    const Icon = getWdbsIconComponent(icon);
    return (
        <div
            className={`flex items-center gap-1 rounded-lg cursor-pointer group transition-colors ${selected ? 'bg-red-600 text-white' : 'text-gray-300 hover:bg-[#272727]'}`}
            style={{ paddingLeft: `${depth * 16 + 4}px` }}
            onClick={onSelect}
            onContextMenu={editable ? (e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e.clientX, e.clientY); } : undefined}
        >
            <button
                onClick={(e) => { e.stopPropagation(); onToggle(); }}
                className={`p-1.5 shrink-0 rounded transition-colors ${hasChildren ? 'cursor-pointer' : 'invisible'} ${selected ? 'text-white hover:bg-white/20' : 'text-gray-500 hover:text-white hover:bg-white/5'}`}
                tabIndex={hasChildren ? 0 : -1}
            >
                {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
            {Icon && <Icon className={`w-3.5 h-3.5 shrink-0 mr-1 ${selected ? 'text-white/80' : 'text-gray-500'}`} />}
            <span className="flex-1 min-w-0 text-sm py-1.5 truncate" title={alias ?? undefined}>{label}</span>
            <span className={`text-[11px] font-medium px-2 shrink-0 ${selected ? 'text-white/80' : 'text-gray-500'}`}>{count}</span>
        </div>
    );
}
