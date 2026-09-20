import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { getWdbsTree, setWdbsAlias, setWdbsIcon, type WdbsNode } from '../api';
import { useWorkspace } from '../hooks/useWorkspace';
import { WdbsAliasMenu } from './WdbsAliasMenu';
import { WdbsIconMenu } from './WdbsIconMenu';
import { getWdbsIconComponent } from '../lib/wdbs-icons';

interface WdbsTreePanelProps {
    // `undefined` means nothing is selected; a real path selects that node (and its descendants
    // — see db/wdbs.rs::list_videos_by_wdbs) elsewhere in whatever's consuming the selection.
    selectedPath: string | undefined;
    onSelect: (path: string, label: string) => void;
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
    // While the selected category's alias would be scrolled out of view it is pinned to the
    // bottom-left of the window. With the vertical navigation rail (16 wide) on the left it has to
    // start to the right of it.
    clearNavRail?: boolean;
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

function findNodeByPath(nodes: WdbsNode[], path: string): WdbsNode | undefined {
    for (const node of nodes) {
        if (node.path === path) return node;
        const found = findNodeByPath(node.children, path);
        if (found) return found;
    }
    return undefined;
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
export function WdbsTreePanel({ selectedPath, onSelect, className, refreshKey, allowEditAlias = false, clearNavRail = false }: WdbsTreePanelProps) {
    const [tree, setTree] = useState<WdbsNode[]>([]);
    const [loading, setLoading] = useState(true);
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

    // Looks up the currently-selected node's alias directly from the already-fetched tree, so the
    // one-line alias strip below doesn't need App.tsx (or any other caller) to thread it through
    // its own selection state on top of the plain path/label onSelect already reports.
    const selectedAlias = selectedPath ? findNodeByPath(tree, selectedPath)?.alias : undefined;

    // The alias strip sits under the tree at the panel's width. Only when that spot isn't fully on
    // screen (a long, expanded tree) does it pin to the window's bottom-left, sized to its text; back
    // in view, it returns to its normal place and width. The slot keeps the strip's height while it is
    // pinned, so nothing below it shifts and the two states can't flip back and forth.
    const slotRef = useRef<HTMLDivElement>(null);
    const stripRef = useRef<HTMLDivElement>(null);
    const [pinned, setPinned] = useState(false);
    const [stripHeight, setStripHeight] = useState(0);
    useEffect(() => {
        const slot = slotRef.current;
        if (!slot || !selectedAlias) { setPinned(false); return; }
        const observer = new IntersectionObserver(
            ([entry]) => setPinned(entry.intersectionRatio < 0.98),
            { threshold: 0.98 },
        );
        observer.observe(slot);
        return () => observer.disconnect();
    }, [selectedAlias]);
    useLayoutEffect(() => {
        if (!pinned && stripRef.current) setStripHeight(stripRef.current.offsetHeight);
    }, [pinned, selectedAlias]);

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
                            allowEditAlias={allowEditAlias}
                            onContextMenu={handleContextMenu}
                        />
                    ))}
                </div>
            )}
            {selectedAlias && (
                <div ref={slotRef} className="mt-2" style={pinned ? { minHeight: stripHeight } : undefined}>
                    <div
                        ref={stripRef}
                        className={`border border-[#272727] rounded-lg px-3 py-1.5 text-xs truncate ${pinned
                            ? `fixed bottom-4 ${clearNavRail ? 'left-20' : 'left-4'} z-30 w-fit max-w-[min(28rem,calc(100vw-2rem))] shadow-lg text-gray-300 bg-[#121212]/75`
                            : 'text-gray-400 bg-[#121212]'}`}
                        title={selectedAlias}
                    >
                        {selectedAlias}
                    </div>
                </div>
            )}
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
    onSelect: (path: string, label: string) => void;
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
                onSelect={() => onSelect(node.path, node.segment)}
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
            {Icon && <Icon className={`w-3.5 h-3.5 shrink-0 ${selected ? 'text-white/80' : 'text-gray-500'}`} />}
            <span className="flex-1 text-sm py-1.5 truncate" title={alias ?? undefined}>{label}</span>
            <span className={`text-[11px] font-medium px-2 shrink-0 ${selected ? 'text-white/80' : 'text-gray-500'}`}>{count}</span>
        </div>
    );
}
