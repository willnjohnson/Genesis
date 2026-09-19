import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { setWorkspaceLabel } from "../../api";
import { useFlags } from "../../hooks/useFlags";
import { useWorkspace } from "../../hooks/useWorkspace";
import { checkLabel, LABEL_DEFS, type LabelKey } from "../../lib/workspace";

interface FieldProps {
    labelKey: LabelKey;
    title: string;
    hint: string;
    max: number;
    defaultValue: string;
    value: string;
    disabled?: boolean;
    disabledNote?: string;
    onSaved: () => Promise<void>;
}

/** One name: type, then Enter or Save to keep it. Saving an empty box goes back to the default. */
function LabelField({ labelKey, title, hint, max, defaultValue, value, disabled, disabledNote, onSaved }: FieldProps) {
    const [draft, setDraft] = useState(value);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // Follow the stored value when it changes underneath (a reload, a sync).
    useEffect(() => { setDraft(value); setError(null); }, [value]);

    const commit = async (next: string) => {
        const checked = checkLabel(next, max);
        if (checked.error) { setError(checked.error); return; }
        if ((checked.value || defaultValue) === value) { setDraft(value); setError(null); return; }
        setSaving(true);
        try {
            await setWorkspaceLabel(labelKey, checked.value);
            setError(null);
            await onSaved();
        } catch (e: any) {
            setError(typeof e === 'string' ? e : e?.message ?? 'Could not save.');
        } finally {
            setSaving(false);
        }
    };

    // Unsaved edits: what's typed differs from what's stored (an empty box means the default).
    const dirty = (draft.trim() || defaultValue) !== value;
    return (
        <div>
            <div className="flex items-baseline justify-between mb-1.5">
                <label className="text-[10px] uppercase font-bold text-[#aaaaaa] tracking-widest">{title}</label>
                <span className="text-[10px] text-[#666666]">{draft.length}/{max}</span>
            </div>
            <div className="flex gap-2">
                <input
                    value={draft}
                    maxLength={max}
                    disabled={disabled || saving}
                    placeholder={defaultValue}
                    onChange={e => { setDraft(e.target.value); setError(null); }}
                    onKeyDown={e => { if (e.key === 'Enter') void commit(draft); }}
                    className="flex-1 min-w-0 bg-[#121212] border border-[#303030] rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-[#555555] disabled:opacity-50"
                />
                {!disabled && (
                    <button
                        type="button"
                        disabled={saving || !dirty}
                        onClick={() => void commit(draft)}
                        className="px-4 py-2 rounded-lg bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] text-xs font-semibold text-white cursor-pointer disabled:opacity-40 disabled:cursor-default disabled:hover:bg-[#222222]"
                    >
                        Save
                    </button>
                )}
            </div>
            {error ? (
                <p className="text-[11px] text-red-400 mt-1">{error}</p>
            ) : (
                <p className="text-[11px] text-[#666666] mt-1">{disabled && disabledNote ? disabledNote : hint}</p>
            )}
        </div>
    );
}

// The Advanced names grouped by the part of the app they rename, in navigation order. Same
// underline-tab styling as the Export tab.
const ADVANCED_TABS: { id: string; label: string; keys: LabelKey[] }[] = [
    { id: 'search', label: 'Search', keys: ['aliasSearch'] },
    { id: 'library', label: 'Library', keys: ['aliasLibrary'] },
    { id: 'glossary', label: 'Glossary', keys: ['aliasGlossary'] },
    { id: 'biography', label: 'Biography', keys: ['aliasBiography', 'aliasBiographyItem'] },
    { id: 'drive', label: 'Drive', keys: ['aliasDriveName', 'aliasDriveLink', 'aliasDriveSymlink'] },
];

export function WorkspaceTab() {
    const { flags } = useFlags();
    const { labels, reload } = useWorkspace();
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [advancedTab, setAdvancedTab] = useState(ADVANCED_TABS[0].id);

    const [nameDef, ...aliasDefs] = LABEL_DEFS;
    const activeTab = ADVANCED_TABS.find(t => t.id === advancedTab) ?? ADVANCED_TABS[0];
    const tabDefs = aliasDefs.filter(d => (activeTab.keys as readonly string[]).includes(d.key));
    // Renaming can be switched off, but a workspace that was never named can always be named once.
    const nameLocked = !flags.allowWorkspaceRename && labels.workspaceName !== nameDef.default;

    return (
        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
            <div>
                <h3 className="text-base font-bold mb-3">Workspace</h3>
                <LabelField
                    labelKey={nameDef.key}
                    title={nameDef.title}
                    hint="Used in export names, e.g. My_Research. Letters, numbers and spaces. Leave it empty and save to go back to the default."
                    max={nameDef.max}
                    defaultValue={nameDef.default}
                    value={labels.workspaceName}
                    disabled={nameLocked}
                    disabledNote="The name of this workspace has been locked."
                    onSaved={reload}
                />
            </div>

            {flags.showWorkspaceAdvanced && (
                <div>
                    <button
                        type="button"
                        onClick={() => setAdvancedOpen(o => !o)}
                        className="flex items-center gap-1.5 text-sm font-bold text-white cursor-pointer"
                    >
                        {advancedOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        Advanced
                    </button>
                    <p className="text-[11px] text-[#666666] mt-1">
                        Rename sections to fit your workspace. Up to 18 characters: letters, numbers and spaces.
                    </p>
                    {advancedOpen && (
                        <div className="mt-4">
                            <div className="flex items-center gap-4 mb-4">
                                {ADVANCED_TABS.map(({ id, label }) => (
                                    <button
                                        key={id}
                                        type="button"
                                        onClick={() => setAdvancedTab(id)}
                                        className={`pb-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer relative ${activeTab.id === id ? 'text-white' : 'text-[#666666] hover:text-[#aaaaaa]'}`}
                                    >
                                        {label}
                                        {activeTab.id === id && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                                    </button>
                                ))}
                            </div>
                            <div className="grid grid-cols-1 gap-4">
                            {tabDefs.map(def => (
                                <LabelField
                                    key={def.key}
                                    labelKey={def.key}
                                    title={def.title}
                                    hint={def.hint}
                                    max={def.max}
                                    defaultValue={def.default}
                                    value={labels[def.key]}
                                    onSaved={reload}
                                />
                            ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
