import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
    ArrowRightLeft, ArrowUpDown, BookA, Check, Link2, ChevronDown, ChevronRight, Film, FolderInput, FolderTree, Inbox,
    LayoutDashboard, Library, ListOrdered, Merge, Pencil, Plus, Search, Trash2,
} from 'lucide-react';
import {
    addVideoWdbsLink, bulkUpdateVideoWdbs, createDrive, decodeWdbs, deleteDrive, encodeWdbs, getDriveManageTree,
    getDriveSequence, getGlossaryTerms, getUnsortedVideoCount, getUnsortedVideos, getWdbsSuggestions, listDriveMembers,
    listDriveSequences, relocateDrive, removeVideoWdbsLink, setWdbsAlias, setWdbsColor, setWdbsIcon, setWdbsShape,
    type DriveMember, type GlossaryTerm, type ManageNode, type RelocateReport, type SequenceEntry, type SequenceSummary,
    type Video,
} from '../../api';
import { Modal } from '../Modal';
import { ConfirmDialog } from '../ConfirmDialog';
import { ContextMenu } from '../ContextMenu';
import { DriveComboBox } from '../DriveComboBox';
import { WdbsAliasMenu } from '../WdbsAliasMenu';
import { WdbsIconMenu } from '../WdbsIconMenu';
import { WdbsColorMenu } from '../WdbsColorMenu';
import { SequenceModal } from '../sidebar/SequenceModal';
import { SearchBar } from '../SearchBar';
import { useVideoPreview } from '../VideoPreview';
import { useBioLinkPreview } from '../GlossaryPreview';
import { sequenceLink } from '../SequenceCard';
import { useWorkspace } from '../../hooks/useWorkspace';
import { getLibraryFacets, getLibraryQuery } from '../../lib/search-facets';
import { getWdbsIconComponent, WDBS_ICON_OPTIONS } from '../../lib/wdbs-icons';
import { getWdbsColorValue, WDBS_COLOR_OPTIONS } from '../../lib/wdbs-colors';
import { WdbsShapeSwatch, WDBS_SHAPE_OPTIONS } from '../../lib/wdbs-shapes';
import { handlePlainContextMenu } from '../../lib/markdown-editor';
import { settingsPrimaryBtn, settingsSecondaryBtn } from '../settings/buttons';

interface Props {
    onClose: () => void;
    /** After anything that changes the Drive or what's filed where, so the Library's tree and grid reload. */
    onChanged: () => void;
    /** After a Drive is renamed, moved or merged (storage paths), so a Library filter on it can follow it. */
    onRelocated: (fromPath: string, toPath: string) => void;
    /** Opens a video in the sidebar; the window closes first. */
    onOpenVideo: (videoId: string) => void;
    /** Shows a Drive's videos in the Library; the window closes first. */
    onShowInLibrary: (path: string, label: string, alias: string | null) => void;
    /** Reordering and removing sequence entries (allowEditSequences). */
    canEditSequences: boolean;
    /** Adding to and clearing sequences (allowEditSequences and allowEditVideosInSequenceList). */
    canBuildSequences: boolean;
    /** The Drive selected in the Library (storage path), to open on. */
    initialPath?: string;
}

type Selection = { kind: 'overview' } | { kind: 'sequences' } | { kind: 'unsorted' } | { kind: 'node'; display: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function flatten(nodes: ManageNode[], out: ManageNode[] = []): ManageNode[] {
    for (const n of nodes) {
        out.push(n);
        flatten(n.children, out);
    }
    return out;
}

function parentOf(display: string): string | null {
    const i = display.lastIndexOf('-');
    return i === -1 ? null : display.slice(0, i);
}

const errorText = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e));

// The app's own pieces, not new ones: buttons as in the Sidebar's Drive editor (and its red Delete), fields as
// its Primary Drive input, small searches as the sequence picker's, labels as its field labels.
// Buttons are Settings' (settings/buttons.ts), pinned to one height (h-8), and every field is that height too, so a
// field and the button beside it line up. A button's label never changes with what's selected: counts go elsewhere.
const neutralButton = `${settingsSecondaryBtn} h-8 py-0 shrink-0`;
const primaryButton = `${settingsPrimaryBtn} h-8 py-0 shrink-0`;
/** The app's red Delete, at the same size. */
const deleteButton = primaryButton;
const driveField = 'h-8 bg-[#121212] border border-[#333] text-white rounded-lg px-3 text-xs font-mono focus:outline-none focus:border-red-600 transition-all placeholder-gray-600 disabled:opacity-50';
const textInput = 'w-full h-8 bg-[#121212] border border-[#333] focus:border-red-600/50 outline-none rounded-lg px-3 text-xs text-white placeholder-[#555]';
const sectionTitle = 'block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2';
/** A label over a field: the small one Settings uses (Database's "Location"). */
const fieldLabel = 'block text-[10px] uppercase font-bold text-[#aaaaaa] tracking-widest mb-1.5';
/** A chip, as the Sidebar's "Also In" list draws them. */
const chip = 'bg-[#1a1a1a] border border-[#333] rounded-md px-2 py-0.5 text-[11px] text-gray-300 font-mono';

/** The chip + icon a Drive shows in the tree, the same as the Library's Drive panel draws them. */
function DriveMarks({ node }: { node: Pick<ManageNode, 'icon' | 'color' | 'shape'> }) {
    const Icon = getWdbsIconComponent(node.icon);
    const color = getWdbsColorValue(node.color);
    return (
        <>
            {color && <WdbsShapeSwatch shape={node.shape ?? 'square'} colorValue={color} borderClassName="border-white/20" />}
            {Icon && <Icon className="w-3.5 h-3.5 shrink-0 text-gray-400" />}
        </>
    );
}

/** A popover (alias, markers) drawn on the page itself: the dialog panel's opening animation transforms it,
 *  which would throw off a `fixed` popover inside it. Esc closes just the popover, not the window under it. */
function Floating({ children }: { children: ReactNode }) {
    return createPortal(
        <div onKeyDown={(e) => { if (e.key === 'Escape') e.preventDefault(); }}>{children}</div>,
        document.body,
    );
}

/**
 * Manage Drive: every Drive in one place, empty ones included. On the left, the tree (with a filter) under
 * three fixed entries: Overview, Sequences and Unsorted. On the right, whichever is picked; for a Drive,
 * its Details (looks and structure: add, rename, move, merge, delete), Videos, Sequence and Terms.
 *
 * Every structural change is previewed first (the backend's dry run) and confirmed with what it will
 * touch; see src-tauri/src/db/drive_manage.rs for how it keeps videos, links, sequences, glossary entries
 * and in-text links in step.
 */
export function DriveManagerModal({ onClose, onChanged, onRelocated, onOpenVideo, onShowInLibrary, canEditSequences, canBuildSequences, initialPath }: Props) {
    const { labels } = useWorkspace();
    const sequenceLabel = labels.aliasSequence;
    const sequenceLower = sequenceLabel.toLowerCase();
    const sequencesLabel = `${sequenceLabel}s`;
    const sequencesLower = sequencesLabel.toLowerCase();
    const [tree, setTree] = useState<ManageNode[] | null>(null);
    const [sequences, setSequences] = useState<SequenceSummary[]>([]);
    const [unsortedCount, setUnsortedCount] = useState(0);
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [selection, setSelection] = useState<Selection>(() =>
        initialPath && initialPath.startsWith('θψ') ? { kind: 'node', display: decodeWdbs(initialPath) } : { kind: 'overview' },
    );
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [filter, setFilter] = useState('');

    const reload = useCallback(async () => {
        try {
            const [t, s, u, sugg] = await Promise.all([getDriveManageTree(), listDriveSequences(), getUnsortedVideoCount(), getWdbsSuggestions()]);
            setTree(t);
            setSequences(s);
            setUnsortedCount(u);
            setSuggestions(sugg.map(decodeWdbs).filter(Boolean));
            setLoadError(null);
        } catch (e) {
            setLoadError(errorText(e));
        }
    }, []);
    useEffect(() => { void reload(); }, [reload]);

    // Anything that changes what's filed where: reload here, and tell the Library.
    const changed = useCallback(async () => {
        await reload();
        onChanged();
    }, [reload, onChanged]);

    const all = useMemo(() => flatten(tree ?? []), [tree]);
    const byDisplay = useMemo(() => new Map(all.map(n => [n.display, n])), [all]);
    const selectedNode = selection.kind === 'node' ? byDisplay.get(selection.display) ?? null : null;

    // Open the branches above the selected Drive, so it's in view.
    useEffect(() => {
        if (selection.kind !== 'node') return;
        const segs = selection.display.slice(1).split('-');
        const above = segs.slice(0, -1).map((_, i) => ':' + segs.slice(0, i + 1).join('-'));
        if (above.length === 0) return;
        setExpanded(prev => (above.every(p => prev.has(p)) ? prev : new Set([...prev, ...above])));
    }, [selection]);

    // A selected Drive that's gone (deleted, or merged away elsewhere) falls back to the Overview.
    useEffect(() => {
        if (tree && selection.kind === 'node' && !byDisplay.has(selection.display)) setSelection({ kind: 'overview' });
    }, [tree, byDisplay, selection]);

    const selectDrive = (display: string) => setSelection({ kind: 'node', display });

    // Opening the full sequence editor (the same one the sidebar uses), over this window.
    const [sequenceFor, setSequenceFor] = useState<{ drive: string; label: string; startInAdd: boolean } | null>(null);
    const openSequence = (drive: string, startInAdd = false) => {
        const node = byDisplay.get(drive);
        setSequenceFor({ drive, label: node?.alias ?? drive, startInAdd });
    };

    const openVideo = (videoId: string) => { onClose(); onOpenVideo(videoId); };
    const showInLibrary = (node: ManageNode) => { onClose(); onShowInLibrary(node.path, node.segment, node.alias); };

    return (
        <Modal
            onClose={onClose}
            icon={FolderTree}
            title="Manage Drive"
            size="full"
            closeOnNavigate
            className="h-[88vh]"
            bodyClassName="p-0"
        >
            <div className="h-full flex min-h-0">
                <aside className="w-72 shrink-0 border-r border-[#303030] flex flex-col min-h-0 bg-[#121212]">
                    <div className="p-3 space-y-1 border-b border-[#303030]">
                        <NavRow icon={LayoutDashboard} label="Overview" hint="Totals, and what needs attention" selected={selection.kind === 'overview'} onClick={() => setSelection({ kind: 'overview' })} />
                        <NavRow icon={ListOrdered} label={sequencesLabel} hint={`Every Drive that has a ${sequenceLower}`} count={sequences.length} selected={selection.kind === 'sequences'} onClick={() => setSelection({ kind: 'sequences' })} />
                        <NavRow icon={Inbox} label="Unsorted" hint="Videos with no Primary Drive yet, to file" count={unsortedCount} selected={selection.kind === 'unsorted'} onClick={() => setSelection({ kind: 'unsorted' })} italic />
                    </div>
                    <div className="p-3 pb-2">
                        <div className="relative">
                            <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                            <input
                                value={filter}
                                onChange={(e) => setFilter(e.target.value)}
                                onContextMenu={handlePlainContextMenu}
                                placeholder="Filter Drives"
                                className={`${textInput} pl-8`}
                            />
                        </div>
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-2 pb-2">
                        {loadError ? (
                            <p className="text-xs text-red-400 px-2">{loadError}</p>
                        ) : !tree ? (
                            <p className="text-xs text-gray-500 px-2">Loading…</p>
                        ) : tree.length === 0 ? (
                            <p className="text-xs text-gray-500 px-2">No Drives yet. Add one below.</p>
                        ) : (
                            <ManageTree
                                nodes={tree}
                                filter={filter.trim().toUpperCase()}
                                expanded={expanded}
                                setExpanded={setExpanded}
                                selected={selection.kind === 'node' ? selection.display : null}
                                onSelect={selectDrive}
                            />
                        )}
                    </div>
                    <div className="p-3 border-t border-[#303030]">
                        <NewDriveForm parent={null} onCreated={async (d) => { await changed(); selectDrive(d); }} />
                    </div>
                </aside>

                <section className="flex-1 min-w-0 min-h-0 overflow-y-auto custom-scrollbar">
                    {selection.kind === 'overview' && tree && (
                        <OverviewPane all={all} tree={tree} sequences={sequences} unsortedCount={unsortedCount} onSelectDrive={selectDrive} onSelect={setSelection} />
                    )}
                    {selection.kind === 'sequences' && (
                        <SequencesPane sequences={sequences} byDisplay={byDisplay} onOpen={(d) => openSequence(d)} onSelectDrive={selectDrive} />
                    )}
                    {selection.kind === 'unsorted' && (
                        <UnsortedPane suggestions={suggestions} onChanged={changed} onOpenVideo={openVideo} />
                    )}
                    {selectedNode && (
                        <NodePane
                            key={selectedNode.display}
                            node={selectedNode}
                            byDisplay={byDisplay}
                            suggestions={suggestions}
                            onReload={reload}
                            onChanged={changed}
                            onRelocated={async (report) => {
                                onRelocated(encodeWdbs(report.from), encodeWdbs(report.to));
                                await changed();
                                selectDrive(report.to);
                            }}
                            onDeleted={async () => { await changed(); setSelection({ kind: 'overview' }); }}
                            onSelectDrive={selectDrive}
                            onOpenVideo={openVideo}
                            onShowInLibrary={() => showInLibrary(selectedNode)}
                            onOpenSequence={openSequence}
                            canEditSequences={canEditSequences}
                            canBuildSequences={canBuildSequences}
                        />
                    )}
                </section>
            </div>

            {sequenceFor && (
                <SequenceModal
                    drive={sequenceFor.drive}
                    driveLabel={sequenceFor.label}
                    currentVideoId=""
                    currentTitle=""
                    ownDrives={[]}
                    canEdit={canEditSequences}
                    canAddVideos={canBuildSequences}
                    startInAdd={sequenceFor.startInAdd}
                    onClose={() => { setSequenceFor(null); void reload(); }}
                    onOpenVideo={(videoId) => { setSequenceFor(null); openVideo(videoId); }}
                    onChanged={() => { onChanged(); }}
                />
            )}
        </Modal>
    );
}

function NavRow({ icon: Icon, label, hint, count, selected, onClick, italic }: { icon: typeof Inbox; label: string; hint: string; count?: number; selected: boolean; onClick: () => void; italic?: boolean }) {
    return (
        <button
            onClick={onClick}
            title={hint}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm transition-colors cursor-pointer ${selected ? 'bg-red-600 text-white' : 'text-gray-300 hover:bg-[#272727]'}`}
        >
            <Icon className={`w-3.5 h-3.5 shrink-0 ${selected ? 'text-white/80' : 'text-gray-500'}`} />
            <span className={`flex-1 text-left truncate ${italic ? 'italic' : ''}`}>{label}</span>
            {count !== undefined && <span className={`text-[11px] ${selected ? 'text-white/80' : 'text-gray-500'}`}>{count}</span>}
        </button>
    );
}

// ─── The tree ────────────────────────────────────────────────────────────────

/** Nothing filed in it or beneath it (Primary or Also In), no sequence, no glossary entries. */
function isEmptyDrive(node: ManageNode): boolean {
    return node.total === 0 && node.terms === 0 && node.sequence === 0;
}

/** Whether `node` or anything beneath it matches the filter (by name, path or alias). */
function matches(node: ManageNode, filter: string): boolean {
    if (!filter) return true;
    if (node.display.includes(filter) || (node.alias ?? '').toUpperCase().includes(filter)) return true;
    return node.children.some(c => matches(c, filter));
}

function ManageTree({ nodes, filter, expanded, setExpanded, selected, onSelect, depth = 0 }: {
    nodes: ManageNode[];
    filter: string;
    expanded: Set<string>;
    setExpanded: (f: (prev: Set<string>) => Set<string>) => void;
    selected: string | null;
    onSelect: (display: string) => void;
    depth?: number;
}) {
    return (
        <>
            {/* Empty Drives go after the rest, at each level (each group stays in name order: the sort is stable). */}
            {nodes.filter(n => matches(n, filter)).sort((a, b) => Number(isEmptyDrive(a)) - Number(isEmptyDrive(b))).map(node => {
                const hasChildren = node.children.length > 0;
                // While filtering, every branch with a match is open.
                const open = filter ? hasChildren : expanded.has(node.display);
                const empty = isEmptyDrive(node);
                const isSelected = selected === node.display;
                return (
                    <div key={node.display}>
                        <div
                            onClick={() => onSelect(node.display)}
                            className={`flex items-center gap-1.5 rounded-lg cursor-pointer transition-colors pr-2 ${isSelected ? 'bg-red-600 text-white' : 'text-gray-300 hover:bg-[#272727]'}`}
                            style={{ paddingLeft: depth * 14 + 2 }}
                            title={node.alias ? `${node.display} (${node.alias})` : node.display}
                        >
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setExpanded(prev => {
                                        const next = new Set(prev);
                                        if (!next.delete(node.display)) next.add(node.display);
                                        return next;
                                    });
                                }}
                                className={`p-1 shrink-0 rounded ${hasChildren && !filter ? 'cursor-pointer hover:bg-white/10' : 'invisible'}`}
                                tabIndex={hasChildren ? 0 : -1}
                                aria-label={open ? 'Collapse' : 'Expand'}
                                title={open ? 'Collapse' : 'Expand'}
                            >
                                {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                            </button>
                            <DriveMarks node={node} />
                            <span className={`flex-1 min-w-0 truncate text-sm py-1 ${empty ? 'italic opacity-60' : ''}`}>
                                {node.segment}
                                {node.alias && <span className={`ml-1.5 text-[11px] ${isSelected ? 'text-white/70' : 'text-gray-500'}`}>{node.alias}</span>}
                            </span>
                            <span className={`text-[11px] shrink-0 ${isSelected ? 'text-white/80' : 'text-gray-500'}`}>{empty ? 'empty' : node.total}</span>
                        </div>
                        {open && hasChildren && (
                            <ManageTree nodes={node.children} filter={filter} expanded={expanded} setExpanded={setExpanded} selected={selected} onSelect={onSelect} depth={depth + 1} />
                        )}
                    </div>
                );
            })}
        </>
    );
}

/** Keeps only what a Drive name may hold (A-Z, 0-9), uppercased, leaving the caret where the edit was. */
function handleDriveNameChange(e: ChangeEvent<HTMLInputElement>, onChange: (v: string) => void) {
    const input = e.target;
    const cursor = input.selectionStart ?? input.value.length;
    const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const value = clean(input.value);
    const caret = clean(input.value.slice(0, cursor)).length;
    input.value = value;
    input.setSelectionRange(caret, caret);
    onChange(value);
}

/**
 * A Drive's own name, after the path it goes under: ":" for a top-level Drive, ":MASTERY-TONY-" for one beneath
 * :MASTERY-TONY. The path is fixed (it's not part of the input, so it can't be deleted) and muted, so it doesn't
 * read as typed; it shows once the field is in use. Styled as the Primary Drive field, and it takes only what a
 * Drive name may hold, as that field does.
 */
function DriveNameInput({ prefix, value, onChange, onEnter, placeholder, autoFocus }: {
    prefix: string;
    value: string;
    onChange: (v: string) => void;
    onEnter: () => void;
    placeholder: string;
    autoFocus?: boolean;
}) {
    const [focused, setFocused] = useState(false);
    const showPrefix = focused || value !== '';
    return (
        <label className={`flex-1 min-w-0 flex items-center cursor-text focus-within:border-red-600 ${driveField}`}>
            {showPrefix && <span className="text-gray-500 select-none shrink-0">{prefix}</span>}
            <input
                autoFocus={autoFocus}
                value={value}
                maxLength={64}
                onChange={(e) => handleDriveNameChange(e, onChange)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onContextMenu={handlePlainContextMenu}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } }}
                placeholder={showPrefix ? '' : placeholder}
                className="flex-1 min-w-0 bg-transparent outline-none text-white placeholder-gray-600"
            />
        </label>
    );
}

/** A name box and an Add button: a new top-level Drive (`parent` null) or one beneath `parent`. */
function NewDriveForm({ parent, onCreated }: { parent: string | null; onCreated: (display: string) => void | Promise<void> }) {
    const [name, setName] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const submit = async () => {
        if (!name.trim() || busy) return;
        setBusy(true);
        setError(null);
        try {
            const display = await createDrive(parent, name);
            setName('');
            await onCreated(display);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <div>
            <div className="flex items-center gap-2">
                <DriveNameInput
                    prefix={parent ? `${parent}-` : ':'}
                    value={name}
                    onChange={setName}
                    onEnter={() => void submit()}
                    placeholder={parent ? 'New sub-Drive' : 'New top-level Drive'}
                />
                <button onClick={() => void submit()} disabled={!name || busy} className={neutralButton} title={parent ? `Add this Drive beneath ${parent}` : "Add this as a top-level Drive"}>
                    <Plus className="w-3.5 h-3.5" />
                    Add
                </button>
            </div>
            {error && <FieldError>{error}</FieldError>}
        </div>
    );
}

// ─── Overview, Sequences, Unsorted ───────────────────────────────────────────

/** A count, laid out as Settings > Database > Storage Management lists them: label left, value right. */
function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
    return (
        <div className="flex items-center justify-between gap-3 bg-[#121212] border border-[#303030] px-3 py-2 rounded-lg" title={hint}>
            <span className="text-[10px] uppercase font-bold text-[#aaaaaa] tracking-widest truncate">{label}</span>
            <span className="text-sm font-bold text-white tabular-nums">{value}</span>
        </div>
    );
}

function FieldError({ children }: { children: ReactNode }) {
    return <div className="mt-2 text-xs text-red-400 bg-red-900/20 border border-red-500/30 rounded-lg px-3 py-2 whitespace-pre-line">{children}</div>;
}

/** A centered line of plain text ending in an underlined link to act on it, which turns the accent color when hovered
 *  (the Overview's "File them." notes). */
function Notice({ children, action, hint, onClick }: { children: ReactNode; action: string; hint: string; onClick: () => void }) {
    return (
        <p className="text-center text-xs text-gray-400">
            {children}{' '}
            <button onClick={onClick} title={hint} className="underline underline-offset-2 hover:text-[var(--k-accent)] transition-colors cursor-pointer">{action}</button>
        </p>
    );
}

function OverviewPane({ all, tree, sequences, unsortedCount, onSelectDrive, onSelect }: {
    all: ManageNode[];
    tree: ManageNode[];
    sequences: SequenceSummary[];
    unsortedCount: number;
    onSelectDrive: (display: string) => void;
    onSelect: (s: Selection) => void;
}) {
    const { labels } = useWorkspace();
    const sequenceLabel = labels.aliasSequence;
    const sequenceLower = sequenceLabel.toLowerCase();
    const sequencesLabel = `${sequenceLabel}s`;
    const sequencesLower = sequencesLabel.toLowerCase();
    const empty = all.filter(isEmptyDrive);
    const stale = sequences.filter(s => s.stale > 0);
    const filed = all.reduce((sum, n) => sum + n.filed, 0);
    const linked = all.reduce((sum, n) => sum + n.linked, 0);
    // Empty Drives start folded away: there can be a lot of them.
    const [emptyOpen, setEmptyOpen] = useState(false);
    const [emptyFilter, setEmptyFilter] = useState('');
    const emptyShown = empty.filter(n => {
        const f = emptyFilter.trim().toUpperCase();
        return !f || n.display.includes(f) || (n.alias ?? '').toUpperCase().includes(f);
    });
    return (
        <div className="p-6 space-y-6">
            <div className="grid grid-cols-2 gap-2">
                <Stat label="Drive Nodes" value={all.length} hint="Every node in the Drive, at every level, empty ones included (as Settings > Database counts them)." />
                <Stat label="Top-level Drives" value={tree.length} hint="Drives with nothing above them (like :CS)." />
                <Stat label="Videos Filed" value={filed} hint="Videos that have a Primary Drive." />
                <Stat label="Also In Links" value={linked} hint="Every Also In link, across all videos. A video linked into two Drives counts twice." />
                <Stat label="Unsorted Videos" value={unsortedCount} hint="Videos with no Primary Drive yet." />
                <Stat label={sequencesLabel} value={sequences.length} hint={`Drives that have a ${sequenceLower} (a watch-through order).`} />
            </div>

            {(unsortedCount > 0 || stale.length > 0) && (
                <div className="space-y-2">
                    {unsortedCount > 0 && (
                        <Notice action="File them." hint="Go to Unsorted to file them under a Drive" onClick={() => onSelect({ kind: 'unsorted' })}>
                            {plural(unsortedCount, 'video')} {unsortedCount === 1 ? "isn't" : "aren't"} filed anywhere yet.
                        </Notice>
                    )}
                    {stale.length > 0 && (
                        <Notice action={`See ${sequencesLower}.`} hint={`Go to the list of ${sequencesLower}`} onClick={() => onSelect({ kind: 'sequences' })}>
                            {plural(stale.length, sequenceLower)} {stale.length === 1 ? 'lists' : 'list'} videos that have left the Drive.
                        </Notice>
                    )}
                </div>
            )}

            <div>
                <button
                    onClick={() => setEmptyOpen(o => !o)}
                    title={empty.length === 0 ? 'Every Drive has something filed in it' : emptyOpen ? 'Hide the empty Drives' : 'Show the empty Drives'}
                    disabled={empty.length === 0}
                    className="flex items-center gap-1 text-xs font-bold text-gray-500 uppercase tracking-widest hover:text-gray-300 cursor-pointer disabled:cursor-default disabled:hover:text-gray-500"
                    aria-expanded={emptyOpen}
                >
                    {empty.length > 0 && (emptyOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />)}
                    Empty Drives ({empty.length})
                </button>
                {emptyOpen && empty.length > 0 && (
                    <div className="mt-2 space-y-2">
                        <div className="relative w-64">
                            <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                            <input value={emptyFilter} onChange={(e) => setEmptyFilter(e.target.value)} onContextMenu={handlePlainContextMenu} placeholder="Filter empty Drives" className={`${textInput} pl-8`} />
                        </div>
                        {emptyShown.length === 0 ? (
                            <p className="text-xs text-gray-500">None match.</p>
                        ) : (
                            <div className="flex flex-wrap gap-1.5">
                                {emptyShown.map(n => (
                                    <button key={n.display} onClick={() => onSelectDrive(n.display)} title={n.alias ?? undefined} className={`${chip} hover:text-white hover:border-[#444] transition-colors cursor-pointer`}>
                                        {n.display}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>

            <div>
                <h3 className={sectionTitle}>Top-level Drives</h3>
                <div className="rounded-xl border border-[#272727] overflow-hidden">
                    <table className="w-full text-xs">
                        <thead className="bg-[#141414] text-gray-500">
                            <tr>
                                <th className="text-left font-semibold px-3 py-2">Drive</th>
                                <th className="w-24 text-center font-semibold px-3 py-2">Videos</th>
                                <th className="w-24 text-center font-semibold px-3 py-2">Sub-Drives</th>
                                <th className="w-24 text-center font-semibold px-3 py-2">Terms</th>
                            </tr>
                        </thead>
                        <tbody>
                            {tree.map(n => (
                                <tr key={n.display} onClick={() => onSelectDrive(n.display)} className="border-t border-[#303030] hover:bg-[#272727] cursor-pointer">
                                    <td className="px-3 py-2">
                                        <span className="inline-flex items-center gap-1.5">
                                            <DriveMarks node={n} />
                                            <span className="font-mono text-gray-200">{n.display}</span>
                                            {n.alias && <span className="text-gray-500">{n.alias}</span>}
                                        </span>
                                    </td>
                                    <td className="px-3 py-2 text-center tabular-nums text-gray-300">{n.total}</td>
                                    <td className="px-3 py-2 text-center tabular-nums text-gray-300">{flatten(n.children).length}</td>
                                    <td className="px-3 py-2 text-center tabular-nums text-gray-300">{n.terms}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}

function SequencesPane({ sequences, byDisplay, onOpen, onSelectDrive }: {
    sequences: SequenceSummary[];
    byDisplay: Map<string, ManageNode>;
    onOpen: (drive: string) => void;
    onSelectDrive: (display: string) => void;
}) {
    const { labels } = useWorkspace();
    const sequenceLabel = labels.aliasSequence;
    const sequenceLower = sequenceLabel.toLowerCase();
    const sequencesLabel = `${sequenceLabel}s`;
    const sequencesLower = sequencesLabel.toLowerCase();
    // A plain filter, no facets: by the Drive's path or its alias.
    const [filter, setFilter] = useState('');
    const f = filter.trim().toUpperCase();
    const shown = f ? sequences.filter(s => s.drive.includes(f) || (byDisplay.get(s.drive)?.alias ?? '').toUpperCase().includes(f)) : sequences;
    return (
        <div className="p-6 space-y-3">
            <h3 className={sectionTitle}>{sequencesLabel} ({sequences.length})</h3>
            {sequences.length > 0 && (
                <div className="relative w-64">
                    <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input value={filter} onChange={(e) => setFilter(e.target.value)} onContextMenu={handlePlainContextMenu} placeholder={`Filter ${sequencesLower}`} className={`${textInput} pl-8`} />
                </div>
            )}
            {sequences.length === 0 ? (
                <p className="text-xs text-gray-500">No Drive has a {sequenceLower} yet. Pick a Drive and open its {sequenceLabel} tab to make one.</p>
            ) : shown.length === 0 ? (
                <p className="text-xs text-gray-500">No {sequencesLower} match.</p>
            ) : (
                <div className="rounded-xl border border-[#272727] overflow-hidden">
                    <table className="w-full text-xs">
                        <thead className="bg-[#141414] text-gray-500">
                            <tr>
                                <th className="text-left font-semibold px-3 py-2">Drive</th>
                                <th className="w-24 text-center font-semibold px-3 py-2">Videos</th>
                                <th className="w-24 text-center font-semibold px-3 py-2" title="Entries whose video has left the Drive">Stale</th>
                                <th className="w-40 px-3 py-2" />
                            </tr>
                        </thead>
                        <tbody>
                            {shown.map(s => {
                                const node = byDisplay.get(s.drive);
                                return (
                                    <tr key={s.drive} className="border-t border-[#222]">
                                        <td className="px-3 py-2">
                                            <button onClick={() => onSelectDrive(s.drive)} title={node?.alias ? `${s.drive} (${node.alias}): show this Drive` : "Show this Drive"} className="inline-flex items-center gap-1.5 cursor-pointer hover:underline">
                                                {node && <DriveMarks node={node} />}
                                                <span className="font-mono text-gray-200">{s.drive}</span>
                                                {node?.alias && <span className="text-gray-500">{node.alias}</span>}
                                            </button>
                                        </td>
                                        <td className="px-3 py-2 text-center tabular-nums text-gray-300">{s.count}</td>
                                        <td className={`px-3 py-2 text-center tabular-nums ${s.stale > 0 ? 'text-[var(--k-accent)] font-bold' : 'text-gray-600'}`}>{s.stale}</td>
                                        <td className="px-3 py-2 text-right whitespace-nowrap">
                                            <CopySequenceLink drive={s.drive} alias={node?.alias ?? null} className="text-xs text-gray-400 hover:text-white hover:underline cursor-pointer mr-3" />
                                            <button onClick={() => onOpen(s.drive)} title={`Open this ${sequenceLower} to reorder, add or remove videos`} className="text-xs text-gray-400 hover:text-white hover:underline cursor-pointer">
                                                Open
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

/** A list of videos with tick boxes: the Unsorted inbox and a Drive's Videos tab. */
function useSelection(ids: string[]) {
    const [picked, setPicked] = useState<Set<string>>(new Set());
    // Drop ticks for rows that are gone after a reload.
    useEffect(() => {
        setPicked(prev => {
            const keep = new Set([...prev].filter(id => ids.includes(id)));
            return keep.size === prev.size ? prev : keep;
        });
    }, [ids]);
    const toggle = (id: string) => setPicked(prev => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
    });
    const allPicked = ids.length > 0 && ids.every(id => picked.has(id));
    const toggleAll = () => setPicked(allPicked ? new Set() : new Set(ids));
    return { picked, setPicked, toggle, allPicked, toggleAll };
}

const UNSORTED_PAGE = 300;

function UnsortedPane({ suggestions, onChanged, onOpenVideo }: { suggestions: string[]; onChanged: () => Promise<void>; onOpenVideo: (id: string) => void }) {
    const [query, setQuery] = useState('');
    const [videos, setVideos] = useState<Video[] | null>(null);
    const [total, setTotal] = useState(0);
    const [target, setTarget] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
    const fetchId = useRef(0);
    // By when each was added to the library: newest first, or (toggled from the note under the list) oldest first.
    const [order, setOrder] = useState<'desc' | 'asc'>('desc');

    const load = useCallback(async (q: string) => {
        const id = ++fetchId.current;
        try {
            const res = await getUnsortedVideos(q, { sortField: 'added', sortOrder: order, limit: UNSORTED_PAGE, offset: 0 });
            if (id !== fetchId.current) return;
            setVideos(res.videos);
            setTotal(res.totalCount ?? res.videos.length);
        } catch (e) {
            if (id === fetchId.current) setMessage({ text: errorText(e), error: true });
        }
    }, [order]);
    useEffect(() => {
        const t = window.setTimeout(() => void load(query.trim()), query ? 250 : 0);
        return () => window.clearTimeout(t);
    }, [query, load]);

    // Memoized: the bar compares these against its own state on every change, so a new array each render won't do.
    const searchFacets = useMemo(() => getLibraryFacets(query, 'library'), [query]);
    const searchText = useMemo(() => getLibraryQuery(query, 'library'), [query]);

    const ids = useMemo(() => (videos ?? []).map(v => v.id), [videos]);
    const sel = useSelection(ids);

    const file = async () => {
        if (!target.trim() || sel.picked.size === 0) return;
        setBusy(true);
        setMessage(null);
        try {
            const res = await bulkUpdateVideoWdbs([...sel.picked], target);
            setMessage({ text: `Filed ${plural(res.succeeded.length, 'video')} under ${target.toUpperCase()}${res.failed.length ? `; ${res.failed.length} failed: ${res.failed[0][1]}` : '.'}`, error: res.failed.length > 0 });
            sel.setPicked(new Set());
            await onChanged();
            await load(query.trim());
        } catch (e) {
            setMessage({ text: errorText(e), error: true });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="p-6 space-y-4">
            <div>
                <h3 className={sectionTitle}>Unsorted ({total})</h3>
                <p className="text-xs text-gray-500">Videos with no home Drive. Tick some, pick a Drive, and file them.</p>
            </div>
            {/* The Library's own search bar, facets, suggestions, history and tips included: the backend reads its query
                the same way here (db::list_unsorted_videos parses the same facets as the Library's search). */}
            <SearchBar
                viewMode="library"
                onSearch={setQuery}
                onLiveFilter={setQuery}
                // Its own state handed back, as App does for the Library's bar; without it the bar resets itself
                // whenever its input loses focus (clicking a facet chip cleared the chips and the text).
                initialFacets={searchFacets}
                initialQuery={searchText}
                loading={false}
                placeholder="Look up unsorted videos and transcripts"
                className=""
            />
            <div className="flex items-center justify-end gap-2">
                <div className="w-72 flex">
                    <DriveComboBox value={target} onValueChange={setTarget} suggestions={suggestions} suggestedDrives={[]} placeholder=":CS-ML-REINF" onEnter={() => void file()} className={driveField} />
                </div>
                <button onClick={() => void file()} disabled={busy || !target.trim() || sel.picked.size === 0} className={primaryButton} title="File the selected videos under this Drive (their Primary Drive)">
                    <FolderInput className="w-3.5 h-3.5" />
                    File
                </button>
            </div>
            {message && <p className={`text-xs ${message.error ? 'text-red-400' : 'text-green-400'}`}>{message.text}</p>}
            <VideoTable
                rows={(videos ?? []).map(v => ({ id: v.id, title: v.title, author: v.author ?? null, video: v }))}
                loading={videos === null}
                emptyText={query ? 'No unsorted videos match.' : 'Every video is filed somewhere.'}
                sel={sel}
                onOpenVideo={onOpenVideo}
            />
            {total > (videos?.length ?? 0) && (
                <p className="text-[11px] text-gray-500">
                    Showing the {videos?.length}{' '}
                    <button
                        onClick={() => setOrder(o => (o === 'desc' ? 'asc' : 'desc'))}
                        title={order === 'desc' ? 'Show the oldest instead' : 'Show the newest instead'}
                        className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-[var(--k-accent)] transition-colors cursor-pointer"
                    >
                        {order === 'desc' ? 'newest' : 'oldest'}
                        <ArrowUpDown className="w-3 h-3" />
                    </button>
                    ; search to narrow.
                </p>
            )}
        </div>
    );
}

/** Above this window (a dialog, z-100) but under a confirmation opened over it (z-200). */
const PREVIEW_Z = 150;

/** A video's name that opens it, with its card (thumbnail, channel, views, dates, transcript/summary) previewed on hover.
 *  No plain tooltip: the preview says more. `video`, when the list already has it all, saves looking the card up. */
function VideoName({ id, title, video, onOpen, className }: { id: string; title: string; video?: Video; onOpen: (id: string) => void; className: string }) {
    const { handlers, card } = useVideoPreview(id, video, PREVIEW_Z);
    return (
        <>
            <button type="button" onClick={(e) => { e.preventDefault(); onOpen(id); }} {...handlers} className={className}>
                {title}
            </button>
            {card}
        </>
    );
}

function VideoAuthor({ author, handle }: { author: string; handle: string | null | undefined }) {
    const preview = useBioLinkPreview(handle ?? '', { zIndex: 160 });
    return (
        <>
            <span {...preview.handlers} className={handle ? 'cursor-help' : undefined}>{author}</span>
            {preview.card}
        </>
    );
}

function VideoTable({ rows, loading, emptyText, sel, onOpenVideo, rowKey = (r) => r.id }: {
    rows: { id: string; title: string; author: string | null; handle?: string | null; badge?: ReactNode; key?: string; video?: Video }[];
    loading: boolean;
    emptyText: string;
    sel: ReturnType<typeof useSelection>;
    onOpenVideo: (id: string) => void;
    rowKey?: (r: { id: string; key?: string }) => string;
}) {
    if (loading) return <p className="text-xs text-gray-500">Loading…</p>;
    if (rows.length === 0) return <p className="text-xs text-gray-500">{emptyText}</p>;
    return (
        <div className="rounded-xl border border-[#272727] overflow-hidden">
            <div className="flex items-center gap-3 px-3 py-2 bg-[#141414] text-[11px] text-gray-500">
                <input type="checkbox" checked={sel.allPicked} onChange={sel.toggleAll} className="cursor-pointer" aria-label="Select all" />
                <span>{sel.picked.size > 0 ? `${sel.picked.size} selected` : `${rows.length} videos`}</span>
            </div>
            <div className="max-h-[48vh] overflow-y-auto custom-scrollbar">
                {rows.map(r => {
                    const key = rowKey(r);
                    return (
                        <label key={key} className="flex items-center gap-3 px-3 py-1.5 border-t border-[#303030] hover:bg-[#272727] cursor-pointer">
                            <input type="checkbox" checked={sel.picked.has(key)} onChange={() => sel.toggle(key)} className="cursor-pointer shrink-0" />
                            <div className="min-w-0 flex-1">
                                <VideoName
                                    id={r.id}
                                    title={r.title}
                                    video={r.video}
                                    onOpen={onOpenVideo}
                                    className="block max-w-full truncate text-left text-xs text-gray-200 hover:text-white hover:underline cursor-pointer"
                                />
                                {r.author && <div className="text-[11px] text-gray-500 truncate"><VideoAuthor author={r.author} handle={r.handle} /></div>}
                            </div>
                            {r.badge}
                        </label>
                    );
                })}
            </div>
        </div>
    );
}

// ─── One Drive ───────────────────────────────────────────────────────────────

type NodeTab = 'details' | 'videos' | 'sequence' | 'terms';

function NodePane(props: {
    node: ManageNode;
    byDisplay: Map<string, ManageNode>;
    suggestions: string[];
    onReload: () => Promise<void>;
    onChanged: () => Promise<void>;
    onRelocated: (report: RelocateReport) => Promise<void>;
    onDeleted: () => Promise<void>;
    onSelectDrive: (display: string) => void;
    onOpenVideo: (id: string) => void;
    onShowInLibrary: () => void;
    onOpenSequence: (drive: string, startInAdd?: boolean) => void;
    canEditSequences: boolean;
    canBuildSequences: boolean;
}) {
    const { labels } = useWorkspace();
    const { node } = props;
    const sequenceLabel = labels.aliasSequence;
    const sequenceLower = sequenceLabel.toLowerCase();
    const [tab, setTab] = useState<NodeTab>('details');
    const isRoot = !node.display.includes('-');
    const segments = node.display.slice(1).split('-');
    const tabs: { key: NodeTab; label: string; count?: number; icon: typeof Film; hint: string }[] = [
        { key: 'details', label: 'Details', icon: Pencil, hint: 'Counts, looks, and changing where this Drive sits' },
        { key: 'videos', label: 'Videos', count: node.filed + node.linked, icon: Film, hint: 'Videos filed here (Primary or Also In), to move or unfile' },
        { key: 'sequence', label: labels.aliasSequence, count: node.sequence, icon: ListOrdered, hint: "This Drive's watch-through order" },
        ...(isRoot ? [{ key: 'terms' as const, label: 'Terms', count: node.terms, icon: BookA, hint: 'Glossary entries filed under this Drive' }] : []),
    ];
    return (
        <div className="flex flex-col min-h-full">
            <div className="px-6 pt-5 pb-0 border-b border-[#272727] sticky top-0 bg-[#0f0f0f] z-10">
                <nav className="flex items-center gap-1 text-xs text-gray-500 font-mono mb-1.5" aria-label="Drive path">
                    {segments.map((seg, i) => {
                        const path = ':' + segments.slice(0, i + 1).join('-');
                        const last = i === segments.length - 1;
                        return (
                            <span key={path} className="flex items-center gap-1">
                                {i > 0 && <ChevronRight className="w-3 h-3" />}
                                {last ? <span className="text-gray-300">{seg}</span> : (
                                    <button onClick={() => props.onSelectDrive(path)} title={`Go to ${path}`} className="hover:text-white hover:underline cursor-pointer">{seg}</button>
                                )}
                            </span>
                        );
                    })}
                </nav>
                <div className="flex items-center gap-2.5">
                    <DriveMarks node={node} />
                    <h3 className="text-xl font-bold text-white truncate">{node.alias ?? node.segment}</h3>
                    <div className="flex-1" />
                    <button onClick={props.onShowInLibrary} disabled={node.total === 0} className={neutralButton} title="Show this Drive's videos in the Library">
                        <Library className="w-3.5 h-3.5" />
                        Show in Library
                    </button>
                </div>
                <div className="flex gap-1 mt-4">
                    {tabs.map(t => (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key)}
                            title={t.hint}
                            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-bold border-b-2 -mb-px transition-colors cursor-pointer ${tab === t.key ? 'border-red-600 text-white' : 'border-transparent text-gray-500 hover:text-gray-200'}`}
                        >
                            <t.icon className="w-3.5 h-3.5" />
                            {t.label}
                            {t.count !== undefined && <span className="text-[10px] text-gray-500 tabular-nums">{t.count}</span>}
                        </button>
                    ))}
                </div>
            </div>
            <div className="p-6">
                {tab === 'details' && <DetailsTab {...props} />}
                {tab === 'videos' && <VideosTab {...props} />}
                {tab === 'sequence' && <SequenceTab {...props} />}
                {tab === 'terms' && isRoot && <TermsTab node={node} />}
            </div>
        </div>
    );
}

// ── Details: stats, looks, structure ─────────────────────────────────────────

function DetailsTab({ node, byDisplay, suggestions, onReload, onChanged, onRelocated, onDeleted, onSelectDrive }: Parameters<typeof NodePane>[0]) {
    const { labels } = useWorkspace();
    const sequenceLabel = labels.aliasSequence;
    const sequenceLower = sequenceLabel.toLowerCase();
    const parent = parentOf(node.display);
    const subDrives = flatten(node.children).length;

    // Looks: alias, category marker (icon), decoration marker (color + shape).
    const [aliasMenu, setAliasMenu] = useState<{ x: number; y: number } | null>(null);
    const [iconMenu, setIconMenu] = useState<{ x: number; y: number } | null>(null);
    const [colorMenu, setColorMenu] = useState<{ x: number; y: number } | null>(null);
    const [looksBusy, setLooksBusy] = useState(false);
    const [looksError, setLooksError] = useState<string | null>(null);
    const at = (e: ReactMouseEvent) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        return { x: r.left, y: r.bottom + 6 };
    };
    const saveLooks = async (run: () => Promise<void>, close?: () => void) => {
        setLooksBusy(true);
        setLooksError(null);
        try {
            await run();
            close?.();
            await onReload();
        } catch (e) {
            setLooksError(errorText(e));
        } finally {
            setLooksBusy(false);
        }
    };
    const IconNow = getWdbsIconComponent(node.icon);
    const iconLabel = WDBS_ICON_OPTIONS.find(o => o.key === node.icon)?.label ?? 'None';
    const colorLabel = WDBS_COLOR_OPTIONS.find(o => o.key === node.color)?.label;
    const shapeLabel = WDBS_SHAPE_OPTIONS.find(o => o.key === (node.shape ?? 'square'))?.label;

    // Structure: every change is previewed (dry run), then confirmed with what it will touch.
    const [renameTo, setRenameTo] = useState(node.segment);
    const [moveUnder, setMoveUnder] = useState('');
    const [mergeInto, setMergeInto] = useState('');
    const [structureError, setStructureError] = useState<string | null>(null);
    // Why a Delete was refused, shown beside the button rather than under the whole section.
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [pending, setPending] = useState<{ title: string; label: string; message: ReactNode; run: () => Promise<void> } | null>(null);
    const [working, setWorking] = useState(false);

    const previewRelocate = async (to: string, verb: 'Rename' | 'Move' | 'Merge') => {
        setStructureError(null);
        try {
            const r = await relocateDrive(node.display, to, true);
            const effects = [
                r.drives > 1 ? `${plural(r.drives, 'Drive')} (it and everything beneath it)` : null,
                r.videos ? `${plural(r.videos, 'video')} filed there` : null,
                r.links ? `${plural(r.links, '"Also in" link')}` : null,
                r.sequences ? plural(r.sequences, sequenceLower) : null,
                r.terms ? `${plural(r.terms, 'glossary entry', 'glossary entries')}${r.termsMovedTo ? ` (refiled under ${r.termsMovedTo}, since terms are only filed at the top level)` : ''}` : null,
                r.texts ? `${plural(r.texts, 'text')} with links to it (summaries, notes, definitions)` : null,
            ].filter(Boolean);
            const headline = r.merged
                ? `${r.from} will be merged into ${r.to}, which already exists: everything in it joins ${r.to}, and ${r.from} goes away. Where ${r.to} has its own alias or markers, they're kept.`
                : `${r.from} will become ${r.to}.`;
            setPending({
                title: r.merged ? 'Merge Drives' : `${verb} Drive`,
                label: r.merged ? 'Merge' : verb,
                message: (
                    <>
                        {headline}
                        {effects.length > 0 ? `\n\nThis updates:\n${effects.map(e => `• ${e}`).join('\n')}` : '\n\nNothing is filed there yet.'}
                    </>
                ),
                run: async () => {
                    const done = await relocateDrive(node.display, to, false);
                    await onRelocated(done);
                },
            });
        } catch (e) {
            setStructureError(errorText(e));
        }
    };

    const rename = () => {
        const seg = renameTo.trim().toUpperCase();
        if (!seg || seg === node.segment) return;
        void previewRelocate(parent ? `${parent}-${seg}` : `:${seg}`, 'Rename');
    };
    const move = () => {
        const target = moveUnder.trim().toUpperCase();
        const to = target ? `${target.startsWith(':') ? target : `:${target}`}-${node.segment}` : `:${node.segment}`;
        void previewRelocate(to, 'Move');
    };
    const merge = () => {
        const target = mergeInto.trim().toUpperCase();
        if (!target) return;
        void previewRelocate(target.startsWith(':') ? target : `:${target}`, 'Merge');
    };
    const remove = async () => {
        setStructureError(null);
        setDeleteError(null);
        try {
            const r = await deleteDrive(node.display, true);
            setPending({
                title: 'Delete Drive',
                label: 'Delete',
                message: `${r.drives > 1 ? `${node.display} and the ${plural(r.drives - 1, 'empty Drive')} beneath it` : node.display} will be deleted.${r.texts ? `\n\n${plural(r.texts, 'text')} with links to it keep the link's words as plain text.` : ''}`,
                run: async () => {
                    await deleteDrive(node.display, false);
                    await onDeleted();
                },
            });
        } catch (e) {
            setDeleteError(errorText(e));
        }
    };

    const suggestionsElsewhere = suggestions.filter(s => s !== node.display && !s.startsWith(`${node.display}-`));
    // Parents offered for a move: every Drive not at or beneath this one, nor its current parent.
    const parentChoices = [...byDisplay.keys()].filter(d => d !== node.display && !d.startsWith(`${node.display}-`) && d !== parent);

    return (
        <div className="space-y-8">
            <div className="grid grid-cols-2 gap-2">
                <Stat label="Filed Here" value={node.filed} hint="Videos whose Primary Drive is exactly this one. Not its sub-Drives', and not ones only here through Also In." />
                <Stat label="Also In Here" value={node.linked} hint="Videos with another Primary Drive that are also filed exactly here (Also In)." />
                <Stat label="Sub-Drives" value={subDrives} hint="Drives beneath this one, at every level." />
                <Stat label={`In ${sequenceLabel}`} value={node.sequence} hint={`Videos in this Drive's own ${sequenceLower} (its watch-through order).`} />
                <div className="col-span-2">
                    <Stat label="Total, With Sub-Drives" value={node.total} hint="Every distinct video here or in any sub-Drive, Primary or Also In. A video filed both ways counts once." />
                </div>
            </div>

            {/* Laid out as the Sidebar's Primary Drive: the current value in a box, an Edit beside it. */}
            <div className="space-y-4">
                <LooksRow label="Alias" onEdit={(e) => { setLooksError(null); setAliasMenu(at(e)); }}>
                    {node.alias ?? <span className="text-gray-600">None</span>}
                </LooksRow>
                <LooksRow label="Category Marker" onEdit={(e) => { setLooksError(null); setIconMenu(at(e)); }}>
                    <span className="flex items-center gap-2">
                        {IconNow && <IconNow className="w-3.5 h-3.5 text-gray-400" />}
                        {IconNow ? iconLabel : <span className="text-gray-600">None</span>}
                    </span>
                </LooksRow>
                <LooksRow label="Decoration Marker" onEdit={(e) => { setLooksError(null); setColorMenu(at(e)); }}>
                    <span className="flex items-center gap-2">
                        {node.color && <WdbsShapeSwatch shape={node.shape ?? 'square'} colorValue={getWdbsColorValue(node.color)!} borderClassName="border-white/20" />}
                        {colorLabel ? `${colorLabel}, ${shapeLabel}` : <span className="text-gray-600">None</span>}
                    </span>
                </LooksRow>
                {looksError && <FieldError>{looksError}</FieldError>}
            </div>

            <div className="space-y-5 pt-2 border-t border-[#272727]">
                <StructureRow title="Add Sub-Drive" hint={`A new Drive beneath ${node.display}.`}>
                    <NewDriveForm parent={node.display} onCreated={async (d) => { await onChanged(); onSelectDrive(d); }} />
                </StructureRow>

                <StructureRow title="Rename" hint="Everything filed in it, or beneath it, follows.">
                    <div className="flex items-center gap-2">
                        <DriveNameInput prefix={parent ? `${parent}-` : ':'} value={renameTo} onChange={setRenameTo} onEnter={rename} placeholder={node.segment} />
                        <button onClick={rename} disabled={!renameTo || renameTo === node.segment} className={neutralButton} title="Rename this Drive (a preview of what changes comes first)">
                            <Pencil className="w-3.5 h-3.5" /> Rename
                        </button>
                    </div>
                </StructureRow>

                <StructureRow title="Move" hint={`Under another Drive, with everything beneath it.${parent ? ' Leave it blank to make it top-level.' : ''}`}>
                    <div className="flex items-center gap-2">
                        <DriveComboBox value={moveUnder} onValueChange={setMoveUnder} suggestions={parentChoices} suggestedDrives={[]} placeholder=":CS-ML" onEnter={move} className={driveField} />
                        <button onClick={move} disabled={!moveUnder.trim() && !parent} className={neutralButton} title="Move this Drive (a preview of what changes comes first)">
                            <ArrowRightLeft className="w-3.5 h-3.5" /> Move
                        </button>
                    </div>
                </StructureRow>

                <StructureRow title="Merge Into" hint="Everything here joins that Drive, and this one goes away. Sub-Drives with the same name merge too.">
                    <div className="flex items-center gap-2">
                        <DriveComboBox value={mergeInto} onValueChange={setMergeInto} suggestions={[...new Set([...suggestionsElsewhere, ...parentChoices])]} suggestedDrives={[]} placeholder=":CS-ML-REINF" onEnter={merge} className={driveField} />
                        <button onClick={merge} disabled={!mergeInto.trim()} className={neutralButton} title="Merge this Drive into the one given (a preview of what changes comes first)">
                            <Merge className="w-3.5 h-3.5" /> Merge
                        </button>
                    </div>
                </StructureRow>

                <StructureRow title="Delete" hint="Only an empty Drive can be deleted: move, unfile or merge what's in it first.">
                    <div className="flex items-center gap-3">
                        <button onClick={() => void remove()} className={deleteButton} title="Delete this Drive and the empty Drives beneath it">
                            <Trash2 className="w-3.5 h-3.5 shrink-0" />
                            Delete
                        </button>
                        {deleteError && <p className="text-xs text-red-400 min-w-0">{deleteError}</p>}
                    </div>
                </StructureRow>

                {structureError && <FieldError>{structureError}</FieldError>}
            </div>

            {aliasMenu && (
                <Floating>
                    <WdbsAliasMenu
                        x={aliasMenu.x}
                        y={aliasMenu.y}
                        segment={node.segment}
                        initialAlias={node.alias ?? ''}
                        onSave={(alias) => void saveLooks(() => setWdbsAlias(node.path, alias), () => setAliasMenu(null))}
                        onClose={() => setAliasMenu(null)}
                        saving={looksBusy}
                        error={looksError}
                    />
                </Floating>
            )}
            {iconMenu && (
                <Floating>
                    <WdbsIconMenu
                        x={iconMenu.x}
                        y={iconMenu.y}
                        segment={node.segment}
                        currentIcon={node.icon}
                        onSelect={(icon) => void saveLooks(() => setWdbsIcon(node.path, icon))}
                        onClose={() => setIconMenu(null)}
                        saving={looksBusy}
                        error={looksError}
                    />
                </Floating>
            )}
            {colorMenu && (
                <Floating>
                    <WdbsColorMenu
                        x={colorMenu.x}
                        y={colorMenu.y}
                        segment={node.segment}
                        currentColor={node.color}
                        currentShape={node.shape}
                        onSelectColor={(color) => void saveLooks(() => setWdbsColor(node.path, color))}
                        onSelectShape={(shape) => void saveLooks(() => setWdbsShape(node.path, shape))}
                        onClear={() => void saveLooks(async () => { await Promise.all([setWdbsColor(node.path, ''), setWdbsShape(node.path, '')]); })}
                        onClose={() => setColorMenu(null)}
                        saving={looksBusy}
                        error={looksError}
                    />
                </Floating>
            )}
            {pending && (
                <ConfirmDialog
                    title={pending.title}
                    confirmLabel={pending.label}
                    message={pending.message}
                    onCancel={() => { if (!working) setPending(null); }}
                    onConfirm={async () => {
                        if (working) return;
                        setWorking(true);
                        try {
                            await pending.run();
                            setPending(null);
                        } catch (e) {
                            setPending(null);
                            setStructureError(errorText(e));
                        } finally {
                            setWorking(false);
                        }
                    }}
                />
            )}
        </div>
    );
}

/** A field label over the field, with a line of help under it, as the Sidebar's Drive editor lays them out. */
function StructureRow({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
    return (
        <div>
            <label className={fieldLabel}>{title}</label>
            {children}
            <p className="text-[11px] text-[#666666] mt-1.5">{hint}</p>
        </div>
    );
}

/** One of a Drive's looks: its current value in a box, and an Edit that opens the same popover as the tree's menu. */
function LooksRow({ label, onEdit, children }: { label: string; onEdit: (e: ReactMouseEvent) => void; children: ReactNode }) {
    return (
        <div>
            <label className={fieldLabel}>{label}</label>
            <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0 h-8 flex items-center bg-[#121212] border border-[#333] rounded-lg px-3 text-xs text-white truncate">{children}</div>
                <button onClick={onEdit} className={neutralButton} title={`Edit the ${label.toLowerCase()}`}>
                    <Pencil className="w-3.5 h-3.5" /> Edit
                </button>
            </div>
        </div>
    );
}

// ── Videos: what's filed here, and moving it ─────────────────────────────────

function VideosTab({ node, suggestions, onChanged, onOpenVideo }: Parameters<typeof NodePane>[0]) {
    const [includeSub, setIncludeSub] = useState(false);
    const [members, setMembers] = useState<DriveMember[] | null>(null);
    const [target, setTarget] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
    const [confirmUnfile, setConfirmUnfile] = useState(false);
    const [membershipMenu, setMembershipMenu] = useState<{ x: number; y: number; label: string; hint: string } | null>(null);

    const load = useCallback(async () => {
        try {
            setMembers(await listDriveMembers(node.display, includeSub));
        } catch (e) {
            setMessage({ text: errorText(e), error: true });
        }
    }, [node.display, includeSub]);
    useEffect(() => { setMembers(null); void load(); }, [load]);

    // One row per home or link, so a row's key says which.
    const keyOf = (m: DriveMember) => `${m.viaLink ? 'link' : 'home'}|${m.at}|${m.videoId}`;
    const keys = useMemo(() => (members ?? []).map(keyOf), [members]);
    const sel = useSelection(keys);
    const picked = (members ?? []).filter(m => sel.picked.has(keyOf(m)));
    const pickedHomes = picked.filter(m => !m.viaLink);
    const pickedLinks = picked.filter(m => m.viaLink);

    const run = async (what: () => Promise<string>) => {
        setBusy(true);
        setMessage(null);
        try {
            const text = await what();
            setMessage({ text });
            sel.setPicked(new Set());
            await onChanged();
            await load();
        } catch (e) {
            setMessage({ text: errorText(e), error: true });
        } finally {
            setBusy(false);
        }
    };

    // Homes move with one bulk call; a link is moved by linking the new Drive, then unlinking this one.
    const moveTo = () => run(async () => {
        const to = target.trim().toUpperCase();
        let moved = 0;
        const failures: string[] = [];
        if (pickedHomes.length) {
            const res = await bulkUpdateVideoWdbs(pickedHomes.map(m => m.videoId), to);
            moved += res.succeeded.length;
            failures.push(...res.failed.map(f => f[1]));
        }
        for (const m of pickedLinks) {
            try {
                if (encodeWdbs(to) !== encodeWdbs(m.home ?? '')) await addVideoWdbsLink(m.videoId, to);
                await removeVideoWdbsLink(m.videoId, encodeWdbs(m.at));
                moved += 1;
            } catch (e) {
                failures.push(errorText(e));
            }
        }
        return `Moved ${plural(moved, 'video')} to ${to}.${failures.length ? ` ${failures.length} couldn't be: ${failures[0]}` : ''}`;
    });
    const unlink = () => run(async () => {
        for (const m of pickedLinks) await removeVideoWdbsLink(m.videoId, encodeWdbs(m.at));
        return `Removed ${plural(pickedLinks.length, '"Also in" link')}.`;
    });
    const unfile = () => run(async () => {
        const res = await bulkUpdateVideoWdbs(pickedHomes.map(m => m.videoId), '');
        return `Sent ${plural(res.succeeded.length, 'video')} to Unsorted.`;
    });

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                    <input type="checkbox" checked={includeSub} onChange={(e) => setIncludeSub(e.target.checked)} className="cursor-pointer" />
                    Include sub-Drives
                </label>
                <div className="flex-1" />
                <div className="w-72 flex">
                    <DriveComboBox value={target} onValueChange={setTarget} suggestions={suggestions} suggestedDrives={[]} placeholder="Move selected to…" onEnter={() => void moveTo()} className={driveField} />
                </div>
                <button onClick={() => void moveTo()} disabled={busy || picked.length === 0 || !target.trim()} className={primaryButton} title="Move the selected videos (or links) to the Drive given">
                    <ArrowRightLeft className="w-3.5 h-3.5" />
                    Move
                </button>
                <button onClick={() => void unlink()} disabled={busy || pickedLinks.length === 0} className={neutralButton} title='Remove the selected "Also in" links (their videos keep their home)'>
                    Remove Links
                </button>
                <button onClick={() => setConfirmUnfile(true)} disabled={busy || pickedHomes.length === 0} className={neutralButton} title="Send the selected videos (filed here as their home) to Unsorted">
                    Unfile
                </button>
            </div>
            {message && <p className={`text-xs ${message.error ? 'text-red-400' : 'text-green-400'}`}>{message.text}</p>}
            <VideoTable
                rows={(members ?? []).map(m => ({
                    id: m.videoId,
                    key: keyOf(m),
                    title: m.title,
                    author: m.author,
                    handle: m.handle,
                    badge: (
                        <span className="flex items-center gap-1.5 shrink-0">
                            {m.at !== node.display && <span className="text-[10px] font-mono text-gray-500">{m.at}</span>}
                            <span
                                onContextMenu={e => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setMembershipMenu({
                                        x: e.clientX,
                                        y: e.clientY,
                                        label: m.viaLink ? 'Also In link' : 'Primary Drive',
                                        hint: m.viaLink ? `Home: ${m.home ?? 'another Drive'}` : "The video's home Drive",
                                    });
                                }}
                                className="shrink-0 text-[10px] text-gray-500 cursor-context-menu"
                                title={m.viaLink && m.home ? `Primary: ${m.home}` : undefined}
                            >
                                {m.viaLink ? 'Also In' : 'Primary'}
                            </span>
                        </span>
                    ),
                }))}
                rowKey={(r) => r.key ?? r.id}
                loading={members === null}
                emptyText={includeSub ? 'Nothing is filed here or beneath it.' : 'Nothing is filed exactly here. Tick "Include sub-Drives" to see what\'s beneath it.'}
                sel={sel}
                onOpenVideo={onOpenVideo}
            />
            {membershipMenu && (
                <ContextMenu
                    x={membershipMenu.x}
                    y={membershipMenu.y}
                    items={[{ label: membershipMenu.label, hint: membershipMenu.hint, disabled: true, onClick: () => {} }]}
                    onClose={() => setMembershipMenu(null)}
                />
            )}
            {confirmUnfile && (
                <ConfirmDialog
                    title="Unfile Videos"
                    confirmLabel="Unfile"
                    message={`${plural(pickedHomes.length, 'video')} will go to Unsorted. Their "Also in" links are removed too, since a link only makes sense alongside a home Drive.`}
                    onCancel={() => setConfirmUnfile(false)}
                    onConfirm={() => { setConfirmUnfile(false); void unfile(); }}
                />
            )}
        </div>
    );
}

// ── Sequence ─────────────────────────────────────────────────────────────────

function SequenceTab({ node, onOpenSequence, onOpenVideo, canEditSequences, canBuildSequences }: Parameters<typeof NodePane>[0]) {
    const { labels } = useWorkspace();
    const sequenceLabel = labels.aliasSequence;
    const sequenceLower = sequenceLabel.toLowerCase();
    const [entries, setEntries] = useState<SequenceEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        setEntries(null);
        getDriveSequence(node.display).then(setEntries).catch(e => setError(errorText(e)));
    }, [node.display, node.sequence]);

    if (error) return <p className="text-xs text-red-400">{error}</p>;
    if (!entries) return <p className="text-xs text-gray-500">Loading…</p>;
    return (
        <div className="space-y-4">
            <div className="flex items-center gap-2">
                <p className="text-xs text-gray-500 flex-1">
                    {entries.length === 0
                        ? `${node.display} has no ${sequenceLower} yet. A ${sequenceLower} is a watch-through order for videos filed here or beneath it.`
                        : `${plural(entries.length, 'video')}, in watch-through order.`}
                </p>
                {entries.length === 0 ? (
                    canBuildSequences && node.total > 0 && (
                        <button onClick={() => onOpenSequence(node.display, true)} className={primaryButton} title="Pick videos filed here to start a watch-through order">
                            <ListOrdered className="w-3.5 h-3.5" />
                            Create {sequenceLabel}
                        </button>
                    )
                ) : (
                    <>
                        <CopySequenceLink drive={node.display} alias={node.alias} className={neutralButton} withIcon />
                        <button onClick={() => onOpenSequence(node.display)} className={neutralButton} title={`Open the ${sequenceLower} editor`}>
                            <ListOrdered className="w-3.5 h-3.5" />
                            {canEditSequences || canBuildSequences ? `Edit ${sequenceLabel}` : `Open ${sequenceLabel}`}
                        </button>
                    </>
                )}
            </div>
            {entries.length > 0 && (
                <ol className="rounded-xl border border-[#272727] overflow-hidden">
                    {entries.map((e, i) => (
                        <li key={e.videoId} className="flex items-center gap-3 px-3 py-1.5 border-t border-[#1f1f1f] first:border-t-0">
                            <span className="w-6 text-right text-[11px] text-gray-500 tabular-nums shrink-0">{i + 1}</span>
                            <VideoName id={e.videoId} title={e.title} onOpen={onOpenVideo} className="min-w-0 truncate text-left text-xs text-gray-200 hover:text-white hover:underline cursor-pointer" />
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
}

/** Copies a markdown link to a Drive's sequence (`[Name sequence](kinesis://sequence/:CS-DSA)`), which opens whatever
 *  is first in the sequence when it's followed. The label stays put; its tooltip says when it's been copied. */
function CopySequenceLink({ drive, alias, className, withIcon }: { drive: string; alias: string | null; className: string; withIcon?: boolean }) {
    const { labels } = useWorkspace();
    const sequenceLower = labels.aliasSequence.toLowerCase();
    const [copied, setCopied] = useState(false);
    const copy = () => {
        navigator.clipboard?.writeText(sequenceLink(drive, alias, labels.aliasSequence)).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
    };
    return (
        <button onClick={copy} className={className} title={copied ? 'Copied' : `Copy a markdown link to this ${sequenceLower} (it opens whatever video is first in it)`}>
            {withIcon && (copied ? <Check className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />)}
            Copy Link
        </button>
    );
}

// ── Terms ────────────────────────────────────────────────────────────────────

function TermsTab({ node }: { node: ManageNode }) {
    const [terms, setTerms] = useState<GlossaryTerm[] | null>(null);
    useEffect(() => {
        getGlossaryTerms().then(all => setTerms(all.filter(t => t.drives.includes(node.display)))).catch(() => setTerms([]));
    }, [node.display]);
    if (!terms) return <p className="text-xs text-gray-500">Loading…</p>;
    if (terms.length === 0) return <p className="text-xs text-gray-500">No glossary entries are filed under {node.display}.</p>;
    return (
        <div className="space-y-2">
            <p className="text-xs text-gray-500">Glossary entries filed under {node.display}. They move with it when it's renamed or merged; edit them in the Glossary.</p>
            <div className="rounded-xl border border-[#272727] overflow-hidden">
                {terms.map(t => (
                    <div key={`${t.term}|${t.drives.join(',')}`} className="px-3 py-2 border-t border-[#1f1f1f] first:border-t-0">
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-gray-200">{t.term}</span>
                            {t.drives.filter(d => d !== node.display).map(d => (
                                <span key={d} className="text-[10px] font-mono text-gray-500 border border-[#333] rounded px-1">{d}</span>
                            ))}
                        </div>
                        {t.definition && <p className="text-xs text-gray-500 line-clamp-2 mt-0.5">{t.definition}</p>}
                    </div>
                ))}
            </div>
        </div>
    );
}
