import { useEffect, useRef, useState, useMemo } from 'react';
import { getGlossaryTerms, deleteGlossaryTerm, saveGlossaryTerm, getGlossaryDriveLinks, getWdbsRoots, type GlossaryTerm, type WdbsRoot } from '../api';
import { Plus, X, Pencil, Check, ChevronDown } from 'lucide-react';
import { useWorkspace } from '../hooks/useWorkspace';
import { ConfirmDialog } from './ConfirmDialog';
import { TermDefinitionModal } from './TermDefinitionModal';
import { normalizeText } from '../lib/utils';
import { handleMarkdownKeyDown, handleMarkdownContextMenu } from '../lib/markdown-editor';
import { useFlags } from '../hooks/useFlags';

// The dropdown's value for "all Quick Tags" (drive roots look like ":CRYPTO", so this can't clash).
const QUICK_VIEW = '__quick__';

const nameOfRoot = (roots: WdbsRoot[], path: string) => roots.find(r => r.path === path)?.segment ?? path.replace(/^:/, '');

/** Dropdown with checkboxes for filing a Standard Glossary Tag under one or more top-level drives.
 *  Only roots (level 1, e.g. CRYPTO) are offered: deeper levels like CRYPTO-DOAC can't be assigned.
 *  The list opens upward: these dialogs clip overflow, and the field sits near their bottom edge. */
function DrivePicker({ roots, selected, onChange }: { roots: WdbsRoot[], selected: string[], onChange: (next: string[]) => void }) {
    const { labels } = useWorkspace();
    const [open, setOpen] = useState(false);
    const boxRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                // Close just the list, not the whole dialog behind it.
                e.stopPropagation();
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey, true);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey, true);
        };
    }, [open]);

    const toggle = (path: string) =>
        onChange(selected.includes(path) ? selected.filter(p => p !== path) : [...selected, path]);

    const names = selected.map(p => nameOfRoot(roots, p));
    const summary = names.length === 0 ? 'None' : names.length <= 2 ? names.join(', ') : `${names.length} selected`;

    return (
        <div ref={boxRef} className="relative">
            <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Categorize to {labels.aliasDriveName}(s)</label>
            {roots.length === 0 ? (
                <p className="text-xs text-gray-500">No {labels.aliasDriveName.toLowerCase()}s yet.</p>
            ) : (
                <>
                    <button
                        type="button"
                        onClick={() => setOpen(o => !o)}
                        aria-haspopup="listbox"
                        aria-expanded={open}
                        className="w-full flex items-center justify-between gap-2 bg-[#121212] border border-[#333] hover:border-[#505050] text-sm rounded-xl px-4 py-3 transition-colors cursor-pointer"
                    >
                        <span className={`truncate ${names.length === 0 ? 'text-gray-600' : 'text-white'}`}>{summary}</span>
                        <ChevronDown className={`w-4 h-4 shrink-0 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} />
                    </button>
                    {open && (
                        <div
                            role="listbox"
                            aria-multiselectable="true"
                            className="absolute left-0 right-0 bottom-full mb-1 z-10 max-h-48 overflow-y-auto bg-[#141414] border border-[#333] rounded-xl py-1 shadow-xl"
                        >
                            {roots.map(r => {
                                const on = selected.includes(r.path);
                                return (
                                    <button
                                        key={r.path}
                                        type="button"
                                        role="option"
                                        aria-selected={on}
                                        onClick={() => toggle(r.path)}
                                        title={r.alias ?? undefined}
                                        className="w-full flex items-center gap-3 px-4 py-2 text-sm text-left text-gray-200 hover:bg-[#222222] transition-colors cursor-pointer"
                                    >
                                        <span className={`w-4 h-4 shrink-0 rounded border flex items-center justify-center ${on ? 'bg-[var(--k-accent)] border-[var(--k-accent)]' : 'border-[#555]'}`}>
                                            {on && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
                                        </span>
                                        <span className="truncate">{r.segment}</span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

export function GlossaryView({ searchQuery, onSearchInLibrary, allowModification = true, onChange }: { searchQuery: string, onSearchInLibrary: (term: string, mode: 'tag' | 'library') => void, allowModification?: boolean, onChange?: () => void }) {
    const { labels } = useWorkspace();
    const glossaryLower = labels.aliasGlossary.toLowerCase();
    const [terms, setTerms] = useState<GlossaryTerm[]>([]);
    const [loading, setLoading] = useState(true);
    const [showAddModal, setShowAddModal] = useState(false);
    const [newTerm, setNewTerm] = useState("");
    const [newDefinition, setNewDefinition] = useState("");
    const [newDrives, setNewDrives] = useState<string[]>([]);
    const [selectedTerm, setSelectedTerm] = useState<GlossaryTerm | null>(null);
    const [termToDelete, setTermToDelete] = useState<GlossaryTerm | null>(null);
    const [termToEdit, setTermToEdit] = useState<{ originalTerm: string, term: string, definition: string, drives: string[] } | null>(null);
    // Top-level drives and each term's assignments.
    const [roots, setRoots] = useState<WdbsRoot[]>([]);
    const [driveLinks, setDriveLinks] = useState<Record<string, string[]>>({});
    // The one dropdown picks what's shown: '' = all Standard Glossary Tags, QUICK_VIEW = all Quick
    // Tags, or a drive root's path (":CRYPTO") = the Standard tags filed under that drive.
    const [view, setView] = useState('');
    // A DB owner can hide Quick Tags, the drive filter and the drive picker (see lib/flags.ts).
    const { flags } = useFlags();
    // If the view on screen has just been hidden, go back to all Standard tags.
    useEffect(() => {
        setView(v => {
            if (v === QUICK_VIEW) return flags.showQuickTags ? v : '';
            if (v !== '' && !flags.glossaryDriveFilterVisible) return '';
            return v;
        });
    }, [flags.showQuickTags, flags.glossaryDriveFilterVisible]);
    const showGlossaryTags = view !== QUICK_VIEW;
    const driveFilter = view !== QUICK_VIEW ? view : '';
    const [saveError, setSaveError] = useState<string | null>(null);

    useEffect(() => {
        loadTerms();
    }, []);

    const loadTerms = async () => {
        try {
            const [res, rootList, links] = await Promise.all([
                getGlossaryTerms(),
                getWdbsRoots().catch(() => [] as WdbsRoot[]),
                getGlossaryDriveLinks().catch(() => [] as [string, string][]),
            ]);
            setTerms(res.map(r => ({ term: r[0], definition: r[1] })));
            setRoots(rootList);
            const byTerm: Record<string, string[]> = {};
            for (const [term, root] of links) (byTerm[term] ??= []).push(root);
            setDriveLinks(byTerm);
            // A drive that no longer exists can't stay selected in the dropdown.
            setView(prev => (prev && prev !== QUICK_VIEW && !rootList.some(r => r.path === prev) ? '' : prev));
        } finally {
            setLoading(false);
        }
    };

    const openAddModal = () => {
        setSaveError(null);
        // Adding while looking at one drive files the new tag there by default.
        setNewDrives(showGlossaryTags && driveFilter ? [driveFilter] : []);
        setShowAddModal(true);
    };

    const handleAdd = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newTerm.trim() || (showGlossaryTags && !newDefinition.trim())) return;
        try {
            await saveGlossaryTerm(null, newTerm.trim(), newDefinition.trim(), showGlossaryTags ? newDrives : []);
        } catch (err) {
            setSaveError(String(err));
            return;
        }
        setNewTerm("");
        setNewDefinition("");
        setNewDrives([]);
        setShowAddModal(false);
        loadTerms();
        onChange?.();
    };

    const handleDelete = async () => {
        if (!termToDelete) return;
        await deleteGlossaryTerm(termToDelete.term);
        setTermToDelete(null);
        if (selectedTerm?.term === termToDelete.term) setSelectedTerm(null);
        loadTerms();
        onChange?.();
    };

    const handleEditSave = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!termToEdit || !termToEdit.term.trim() || (showGlossaryTags && !termToEdit.definition.trim())) return;

        // One atomic save: a rename moves the term's drive assignments along with it.
        try {
            await saveGlossaryTerm(termToEdit.originalTerm, termToEdit.term.trim(), termToEdit.definition.trim(), showGlossaryTags ? termToEdit.drives : []);
        } catch (err) {
            setSaveError(String(err));
            return;
        }
        setTermToEdit(null);
        if (selectedTerm?.term === termToEdit.originalTerm) {
            setSelectedTerm({ term: termToEdit.term.trim(), definition: termToEdit.definition.trim() });
        }
        loadTerms();
        onChange?.();
    };

    const filteredTerms = useMemo(() => {
        const isDef = searchQuery.includes("definition_search:");
        const q = normalizeText(searchQuery.replace(/term_search:/g, '').replace(/definition_search:/g, '').replace(/"/g, '').trim());
        let filtered = terms;
        if (showGlossaryTags) {
            filtered = terms.filter(t => t.definition.trim().length > 0);
            // Only Standard tags belong to drives; picking one shows just the tags filed under it.
            if (driveFilter) filtered = filtered.filter(t => (driveLinks[t.term] ?? []).includes(driveFilter));
        } else {
            filtered = terms.filter(t => t.definition.trim().length === 0);
        }
        if (!q) return filtered;
        return filtered.filter(t => {
            if (isDef) return normalizeText(t.definition).includes(q);
            return normalizeText(t.term).includes(q);
        });
    }, [terms, searchQuery, showGlossaryTags, driveFilter, driveLinks]);

    const groupedTerms = useMemo(() => {
        const groups: Record<string, GlossaryTerm[]> = {};
        for (const t of filteredTerms) {
            const firstChar = t.term.charAt(0).toUpperCase();
            const groupKey = /[A-Z]/.test(firstChar) ? firstChar : '#';
            if (!groups[groupKey]) groups[groupKey] = [];
            groups[groupKey].push(t);
        }
        return groups;
    }, [filteredTerms]);

    const groupKeys = Object.keys(groupedTerms).sort((a, b) => {
        if (a === '#') return -1;
        if (b === '#') return 1;
        return a.localeCompare(b);
    });

    if (loading) return null;

    return (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-400">
            <div className="flex justify-between items-center mb-4 px-4">
                <h2 className="text-xl font-bold text-white">{labels.aliasGlossary}</h2>
                <div className="flex items-center gap-3">
                    {(flags.showQuickTags || (flags.glossaryDriveFilterVisible && roots.length > 0)) && (
                    <select
                        value={view}
                        onChange={e => setView(e.target.value)}
                        aria-label={`Show ${glossaryLower} tags: all Standard, all Quick, or by ${labels.aliasDriveName}`}
                        className="px-3 py-1.5 bg-[#272727] hover:bg-[#3f3f3f] text-white rounded-md transition-colors text-[11px] font-semibold cursor-pointer outline-none"
                    >
                        <option value="">All Standard {labels.aliasGlossary} Tags</option>
                        {flags.showQuickTags && <option value={QUICK_VIEW}>All Quick Tags</option>}
                        {flags.glossaryDriveFilterVisible && roots.map(r => (
                            <option key={r.path} value={r.path} title={r.alias ?? undefined}>{r.segment}</option>
                        ))}
                    </select>
                    )}
                    {allowModification && (
                        <button
                            onClick={openAddModal}
                            className="flex items-center gap-1.5 px-2 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-md transition-colors text-[11px] font-semibold cursor-pointer"
                        >
                            <Plus className="w-4 h-4" /> Add Term
                        </button>
                    )}
                </div>
            </div>

            <div className="px-4">
                {terms.length === 0 ? (
                    <div className="text-center text-gray-500 py-24 bg-[#121212] rounded-xl border border-[#272727]">
                        <p className="text-xl font-bold text-white mb-2">No glossary terms have been added</p>
                        <p className="text-sm">Click the Add Term button to create your first glossary entry.</p>
                    </div>
                ) : filteredTerms.length === 0 ? (
                    <div className="text-center text-gray-500 py-24 bg-[#121212] rounded-xl border border-[#272727]">
                        {showGlossaryTags && driveFilter && !searchQuery.trim() ? (
                            <>
                                <p className="text-xl font-bold text-white mb-2">No {glossaryLower} tags in {nameOfRoot(roots, driveFilter)}</p>
                                <p className="text-md">Edit a tag and pick this {labels.aliasDriveName.toLowerCase()} to file it here.</p>
                            </>
                        ) : (
                            <>
                                <p className="text-xl font-bold text-white mb-2">No {showGlossaryTags ? `${glossaryLower} tags` : "quick tags"} found</p>
                                <p className="text-md">No {showGlossaryTags ? `${glossaryLower} tags` : "quick tags"} match your search.</p>
                            </>
                        )}
                    </div>
                ) : (
                    <div className="space-y-8">
                        {groupKeys.map(char => (
                            <div key={char}>
                                <h3 className="text-xl font-bold text-[#aaaaaa] border-b border-[#333] pb-2 mb-4">{char}</h3>
                                <ul className="space-y-1.5 pl-2">
                                    {groupedTerms[char].map(t => (
                                        <li key={t.term} className="text-gray-300 flex items-center group">
                                            <div className="w-1.5 h-1.5 rounded-full bg-[#444] mr-3 shrink-0 group-hover:bg-[var(--k-accent)] transition-colors"></div>
                                            <button
                                                onClick={() => setSelectedTerm(t)}
                                                className="group-hover:text-[var(--k-accent)] transition-colors cursor-pointer text-base font-medium text-left flex-1 hover:underline hover:decoration-dotted hover:underline-offset-4"
                                            >
                                                {t.term}
                                            </button>
                                            {allowModification && (
                                                <>
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setSaveError(null);
                                                            setTermToEdit({ originalTerm: t.term, term: t.term, definition: t.definition, drives: driveLinks[t.term] ?? [] });
                                                        }}
                                                        className="text-gray-500 hover:text-blue-400 transition-colors cursor-pointer p-1"
                                                        title="Edit term"
                                                    >
                                                        <Pencil className="w-3.5 h-3.5" />
                                                    </button>
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); setTermToDelete(t); }}
                                                        className="text-gray-500 hover:text-red-500 transition-colors cursor-pointer p-1"
                                                        title="Delete term"
                                                    >
                                                        <X className="w-3.5 h-3.5" />
                                                    </button>
                                                </>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                                  </div>
                              )}
                         </div>

            {/* Add Modal */}
            {showAddModal && (
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 animate-in fade-in duration-200"
                    onClick={() => setShowAddModal(false)}
                >
                    <form
                        onSubmit={handleAdd}
                        onClick={e => e.stopPropagation()}
                        className="bg-[#0f0f0f] border border-[#303030] rounded-2xl w-full max-w-md flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
                    >
                        {/* Header */}
                        <div className="px-6 py-4 border-b border-[#303030] flex items-center justify-between bg-[#141414]">
                            <div className="flex items-center gap-2 text-gray-200">
                                <Plus className="w-4 h-4" />
                                <h2 className="text-lg font-bold">Add {showGlossaryTags ? `${labels.aliasGlossary} Tag` : "Quick Tag"}</h2>
                            </div>
                            <button type="button" onClick={() => setShowAddModal(false)} className="text-gray-500 hover:text-white transition-colors cursor-pointer">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="p-6 space-y-6">
                             <div>
                                 <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Term Name</label>
                                 <input
                                     type="text"
                                     autoFocus
                                     required
                                     value={newTerm}
                                     onChange={e => setNewTerm(e.target.value)}
                                     className="w-full bg-[#121212] border border-[#333] text-white rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-red-600 transition-all placeholder-gray-600"
                                     placeholder="Enter term..."
                                 />
                             </div>
                             {showGlossaryTags && (
                                 <div>
                                     <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Definition</label>
                                     <textarea
                                         required
                                         value={newDefinition}
                                         onChange={e => setNewDefinition(e.target.value)}
                                         onContextMenu={handleMarkdownContextMenu}
                                         onKeyDown={(e) => handleMarkdownKeyDown(e, newDefinition, setNewDefinition)}
                                         rows={8}
                                         className="w-full bg-[#121212] border border-[#333] text-white rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-red-600 transition-all resize-none placeholder-gray-600"
                                         placeholder="Enter definition (Markdown supported)..."
                                     />
                                 </div>
                             )}
                             {showGlossaryTags && flags.glossaryDrivePickerVisible && (
                                 <DrivePicker roots={roots} selected={newDrives} onChange={setNewDrives} />
                             )}
                             {saveError && (
                                 <div className="text-xs text-red-400 bg-red-900/20 border border-red-500/30 rounded-lg px-3 py-2">{saveError}</div>
                             )}
                        </div>

                        {/* Footer */}
                        <div className="px-6 py-4 border-t border-[#303030] flex justify-end gap-3 bg-[#141414]">
                            <button
                                type="button"
                                onClick={() => setShowAddModal(false)}
                                className="px-4 py-2 rounded-lg bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] cursor-pointer text-white text-sm font-semibold transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                className="px-6 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white transition-all text-sm font-bold cursor-pointer"
                            >
                                Save Term
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {/* Edit Modal */}
            {termToEdit && (
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 animate-in fade-in duration-200"
                    onClick={() => setTermToEdit(null)}
                >
                    <form
                        onSubmit={handleEditSave}
                        onClick={e => e.stopPropagation()}
                        className="bg-[#0f0f0f] border border-[#303030] rounded-2xl w-full max-w-md flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
                    >
                        {/* Header */}
                        <div className="px-6 py-4 border-b border-[#303030] flex items-center justify-between bg-[#141414]">
                            <div className="flex items-center gap-2 text-gray-200">
                                <Pencil className="w-4 h-4" />
                                <h2 className="text-lg font-bold">Edit {showGlossaryTags ? `${labels.aliasGlossary} Tag` : "Quick Tag"}</h2>
                            </div>
                            <button type="button" onClick={() => setTermToEdit(null)} className="text-gray-500 hover:text-white transition-colors cursor-pointer">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="p-6 space-y-6">
                             <div>
                                 <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Term Name</label>
                                 <input
                                     type="text"
                                     required
                                     value={termToEdit.term}
                                     onChange={e => setTermToEdit({ ...termToEdit, term: e.target.value })}
                                     className="w-full bg-[#121212] border border-[#333] text-white rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-600 transition-all placeholder-gray-600"
                                 />
                             </div>
                             {showGlossaryTags && (
                                 <div>
                                     <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Definition</label>
                                      <textarea
                                          required
                                          value={termToEdit.definition}
                                          onChange={e => setTermToEdit(prev => (prev ? { ...prev, definition: e.target.value } : prev))}
                                          onContextMenu={handleMarkdownContextMenu}
                                          onKeyDown={(e) => handleMarkdownKeyDown(e, termToEdit.definition, (val) => setTermToEdit(prev => (prev ? { ...prev, definition: val } : prev)))}
                                          rows={8}
                                          className="w-full bg-[#121212] border border-[#333] text-white rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-600 transition-all resize-none placeholder-gray-600"
                                      />
                                 </div>
                             )}
                             {showGlossaryTags && flags.glossaryDrivePickerVisible && (
                                 <DrivePicker
                                     roots={roots}
                                     selected={termToEdit.drives}
                                     onChange={drives => setTermToEdit(prev => (prev ? { ...prev, drives } : prev))}
                                 />
                             )}
                             {saveError && (
                                 <div className="text-xs text-red-400 bg-red-900/20 border border-red-500/30 rounded-lg px-3 py-2">{saveError}</div>
                             )}
                        </div>

                        {/* Footer */}
                        <div className="px-6 py-4 border-t border-[#303030] flex justify-end gap-3 bg-[#141414]">
                            <button
                                type="button"
                                onClick={() => setTermToEdit(null)}
                                className="px-4 py-2 rounded-lg bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] cursor-pointer text-white text-sm font-semibold transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-all text-sm font-bold cursor-pointer"
                            >
                                Save Changes
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {/* View Definition Modal */}
            {selectedTerm && (
                <TermDefinitionModal
                    term={selectedTerm}
                    onClose={() => setSelectedTerm(null)}
                    onSearch={onSearchInLibrary}
                />
            )}

            {/* Confirm Delete Modal */}
            {termToDelete && (
                <ConfirmDialog
                    message={`Are you sure you want to delete the term "${termToDelete.term}"?`}
                    onConfirm={handleDelete}
                    onCancel={() => setTermToDelete(null)}
                />
            )}
        </div>
    );
}
