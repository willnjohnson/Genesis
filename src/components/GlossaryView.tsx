import { useEffect, useState, useMemo } from 'react';
import { getGlossaryTerms, addGlossaryTerm, deleteGlossaryTerm, type GlossaryTerm } from '../api';
import { Plus, X, Pencil } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { TermDefinitionModal } from './TermDefinitionModal';
import { normalizeText } from '../lib/utils';
import { handleMarkdownKeyDown } from './Sidebar';

export function GlossaryView({ searchQuery, onSearchInLibrary, allowModification = true, onChange }: { searchQuery: string, onSearchInLibrary: (term: string, mode: 'title' | 'transcript' | 'tag' | 'summary') => void, allowModification?: boolean, onChange?: () => void }) {
    const [terms, setTerms] = useState<GlossaryTerm[]>([]);
    const [loading, setLoading] = useState(true);
    const [showAddModal, setShowAddModal] = useState(false);
    const [newTerm, setNewTerm] = useState("");
    const [newDefinition, setNewDefinition] = useState("");
    const [selectedTerm, setSelectedTerm] = useState<GlossaryTerm | null>(null);
    const [termToDelete, setTermToDelete] = useState<GlossaryTerm | null>(null);
    const [termToEdit, setTermToEdit] = useState<{ originalTerm: string, term: string, definition: string } | null>(null);
    const [showGlossaryTags, setShowGlossaryTags] = useState(true);



    useEffect(() => {
        loadTerms();
    }, []);

    const loadTerms = async () => {
        try {
            const res = await getGlossaryTerms();
            setTerms(res.map(r => ({ term: r[0], definition: r[1] })));
        } finally {
            setLoading(false);
        }
    };

    const handleAdd = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newTerm.trim() || (showGlossaryTags && !newDefinition.trim())) return;
        await addGlossaryTerm(newTerm.trim(), newDefinition.trim());
        setNewTerm("");
        setNewDefinition("");
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

        if (termToEdit.term.trim() !== termToEdit.originalTerm) {
            await deleteGlossaryTerm(termToEdit.originalTerm);
        }
        await addGlossaryTerm(termToEdit.term.trim(), termToEdit.definition.trim());
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
        } else {
            filtered = terms.filter(t => t.definition.trim().length === 0);
        }
        if (!q) return filtered;
        return filtered.filter(t => {
            if (isDef) return normalizeText(t.definition).includes(q);
            return normalizeText(t.term).includes(q);
        });
    }, [terms, searchQuery, showGlossaryTags]);

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
                <h2 className="text-xl font-bold text-white">Glossary</h2>
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => setShowGlossaryTags(!showGlossaryTags)}
                        className="flex items-center gap-2 px-3 py-1.5 bg-[#272727] hover:bg-[#3f3f3f] text-white rounded-md transition-colors text-[11px] font-semibold cursor-pointer"
                    >
                        {showGlossaryTags ? "Standard Glossary Tags" : "Quick Tags"}
                    </button>
                    {allowModification && (
                        <button
                            onClick={() => setShowAddModal(true)}
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
                        <p className="text-xl font-bold text-white mb-2">No {showGlossaryTags ? "glossary tags" : "quick tags"} found</p>
                        <p className="text-md">No {showGlossaryTags ? "glossary tags" : "quick tags"} match your search.</p>
                    </div>
                ) : (
                    <div className="space-y-8">
                        {groupKeys.map(char => (
                            <div key={char}>
                                <h3 className="text-xl font-bold text-[#aaaaaa] border-b border-[#333] pb-2 mb-4">{char}</h3>
                                <ul className="space-y-1.5 pl-2">
                                    {groupedTerms[char].map(t => (
                                        <li key={t.term} className="text-gray-300 flex items-center group">
                                            <div className="w-1.5 h-1.5 rounded-full bg-[#444] mr-3 shrink-0 group-hover:bg-red-400 transition-colors"></div>
                                            <button
                                                onClick={() => setSelectedTerm(t)}
                                                className="group-hover:text-red-400 transition-colors cursor-pointer text-base font-medium text-left flex-1 hover:underline hover:decoration-dotted hover:underline-offset-4"
                                            >
                                                {t.term}
                                            </button>
                                            {allowModification && (
                                                <>
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setTermToEdit({ originalTerm: t.term, term: t.term, definition: t.definition });
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
                                <h2 className="text-lg font-bold">Add {showGlossaryTags ? "Glossary Tag" : "Quick Tag"}</h2>
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
                                         onKeyDown={(e) => handleMarkdownKeyDown(e, newDefinition, setNewDefinition)}
                                         rows={8}
                                         className="w-full bg-[#121212] border border-[#333] text-white rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-red-600 transition-all resize-none placeholder-gray-600"
                                         placeholder="Enter definition (Markdown supported)..."
                                     />
                                 </div>
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
                                <h2 className="text-lg font-bold">Edit {showGlossaryTags ? "Glossary Tag" : "Quick Tag"}</h2>
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
                                          onChange={e => setTermToEdit(prev => ({ ...prev, definition: e.target.value }))}
                                          onKeyDown={(e) => handleMarkdownKeyDown(e, termToEdit.definition, (val) => setTermToEdit(prev => ({ ...prev, definition: val })))}
                                          rows={8}
                                          className="w-full bg-[#121212] border border-[#333] text-white rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-600 transition-all resize-none placeholder-gray-600"
                                      />
                                 </div>
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
