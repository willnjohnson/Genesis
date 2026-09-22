import { useEffect, useRef, useState } from "react";
import { ArrowLeftRight, BookA, BookMarked, ChevronDown, ChevronRight, FolderOpen, HardDrive, Search, Shield, UserSearch, type LucideIcon } from "lucide-react";
import { getWorkspaceStatus, revealWorkspace, setWorkspaceLabel, type WorkspaceStatus } from "../../api";
import { WorkspaceLauncher } from "../workspace/WorkspaceLauncher";
import { ErrorBox } from "../workspace/shared";
import { errText } from "../workspace/helpers";
import { settingsSecondaryBtn } from "./buttons";
import { useFlags } from "../../hooks/useFlags";
import { useWorkspace } from "../../hooks/useWorkspace";
import { checkLabel, LABEL_DEFS, type LabelKey } from "../../lib/workspace";
import { PermissionsPanel } from "./PermissionsPanel";

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
                    className="flex-1 min-w-0 bg-[#121212] border border-[#303030] rounded-lg px-3 py-2 text-[11px] text-white outline-none focus:border-[#555555] disabled:opacity-50"
                />
                {!disabled && (
                    <button
                        type="button"
                        disabled={saving || !dirty}
                        onClick={() => void commit(draft)}
                        className={settingsSecondaryBtn}
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

// The Advanced names grouped by the part of the app they rename, in navigation order, plus
// Permissions (which renders PermissionsPanel instead of LabelFields — see its `keys: []` and the
// branch in the render below). Same underline-tab styling as the Export tab. Icons match the main
// nav rail's own icons for these exact views (App.tsx), so "Library" always means BookMarked, etc.
const ADVANCED_TABS: { id: string; label: string; icon: LucideIcon; keys: LabelKey[] }[] = [
    { id: 'search', label: 'Search', icon: Search, keys: ['aliasSearch'] },
    { id: 'library', label: 'Library', icon: BookMarked, keys: ['aliasLibrary'] },
    { id: 'glossary', label: 'Glossary', icon: BookA, keys: ['aliasGlossary'] },
    { id: 'biography', label: 'Biography', icon: UserSearch, keys: ['aliasBiography', 'aliasBiographyItem'] },
    { id: 'drive', label: 'Drive', icon: HardDrive, keys: ['aliasDriveName', 'aliasDriveLink', 'aliasDriveSymlink'] },
    { id: 'permissions', label: 'Permissions', icon: Shield, keys: [] },
];

// Below this width (px), the sub-tab row shows icons alone (with a tooltip) instead of icon + label —
// same ResizeObserver approach as the sequence bar's Previous/Next labels (SequenceDock.tsx): a
// Settings modal can be small, and 6 labelled tabs don't always fit.
const TABS_ICON_ONLY_BELOW = 480;

export function WorkspaceTab() {
    const { flags } = useFlags();
    const { labels, reload } = useWorkspace();
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [advancedTab, setAdvancedTab] = useState(ADVANCED_TABS[0].id);
    const [status, setStatus] = useState<WorkspaceStatus | null>(null);
    const [launcherOpen, setLauncherOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Collapses the sub-tab row to icons alone once it's too narrow for icon + label.
    const tabsRowRef = useRef<HTMLDivElement>(null);
    const [tabsIconOnly, setTabsIconOnly] = useState(false);
    useEffect(() => {
        const el = tabsRowRef.current;
        if (!el) return;
        const observer = new ResizeObserver(([entry]) => setTabsIconOnly(entry.contentRect.width < TABS_ICON_ONLY_BELOW));
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    // Re-read when the name changes: renaming the workspace renames its folder too.
    useEffect(() => {
        getWorkspaceStatus().then(setStatus).catch(e => setError(errText(e)));
    }, [labels.workspaceName]);

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
                    hint="Also the name of the workspace's folder, and used in export names, e.g. My_Research. Letters, numbers and spaces. Leave it empty and save to go back to the default."
                    max={nameDef.max}
                    defaultValue={nameDef.default}
                    value={labels.workspaceName}
                    disabled={nameLocked}
                    disabledNote="The name of this workspace has been locked."
                    onSaved={reload}
                />
                <div className="flex gap-2 mt-4">
                    {flags.allowChangeDbLocation && (
                        <button onClick={() => status && setLauncherOpen(true)} disabled={!status} className={settingsSecondaryBtn}>
                            <ArrowLeftRight className="w-3.5 h-3.5" />
                            Switch workspace
                        </button>
                    )}
                    {status?.current && (
                        <button onClick={() => revealWorkspace(status.current!.folder).catch(e => setError(errText(e)))} className={settingsSecondaryBtn}>
                            <FolderOpen className="w-3.5 h-3.5" />
                            Show folder
                        </button>
                    )}
                </div>
                {status?.current && <p className="text-[11px] text-[#666666] mt-2 break-all select-all">{status.current.path}</p>}
                {error && <div className="mt-3"><ErrorBox>{error}</ErrorBox></div>}
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
                        {activeTab.id === 'permissions'
                            ? "Turn specific editing permissions on or off for this workspace."
                            : "Rename sections to fit your workspace. Up to 18 characters: letters, numbers and spaces."}
                    </p>
                    {advancedOpen && (
                        <div className="mt-4">
                            <div ref={tabsRowRef} className="flex items-center gap-4 mb-4">
                                {ADVANCED_TABS.map(({ id, label, icon: Icon }) => (
                                    <button
                                        key={id}
                                        type="button"
                                        onClick={() => setAdvancedTab(id)}
                                        title={tabsIconOnly ? label : undefined}
                                        className={`flex items-center gap-1.5 pb-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer relative ${activeTab.id === id ? 'text-white' : 'text-[#666666] hover:text-[#aaaaaa]'}`}
                                    >
                                        {tabsIconOnly ? <Icon className="w-3.5 h-3.5 shrink-0" /> : label}
                                        {activeTab.id === id && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                                    </button>
                                ))}
                            </div>
                            {activeTab.id === 'permissions' ? (
                                <PermissionsPanel />
                            ) : (
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
                            )}
                        </div>
                    )}
                </div>
            )}

            {launcherOpen && status && <WorkspaceLauncher status={status} onClose={() => setLauncherOpen(false)} />}
        </div>
    );
}
