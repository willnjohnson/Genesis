import { useEffect, useState } from "react";
import { Shield } from "lucide-react";
import { getSettings, setSetting } from "../../api";
import { useFlags } from "../../hooks/useFlags";
import { useLockedSettings, LOCKED_TITLE } from "../../hooks/useLockedSettings";
import { READ_ONLY_OVERRIDE_KEYS, type FlagKey } from "../../lib/flags";
import { ErrorBox } from "../workspace/shared";

// Label/hint for each flag in READ_ONLY_OVERRIDE_KEYS that doesn't already have its own dedicated
// control elsewhere in Settings — this list exists so there's SOME way to reach a flag no other
// screen offers, not to give every flag a second home. One of the sixteen is deliberately left out:
//   - allowClearHistory: History's own Settings view (Keep search history / Clear history after) is
//     already where Search History configuration lives.
// (allowEditWDBS used to have its own toggle in PluginsTab — a permission living among a list of
// external-service integrations it had nothing to do with. It belongs here instead, alongside every
// other allowEdit* flag, not off on its own.) Still in READ_ONLY_OVERRIDE_KEYS and still forced off
// by Read-only — omitting a row here only means this generic list doesn't duplicate a switch that
// already exists somewhere better-suited. Partial (not a full Record<FlagKey, ...>) for exactly that
// reason; ROWS below filters READ_ONLY_OVERRIDE_KEYS down to the keys actually present here, rather
// than assuming full coverage, so the render order still comes from that one shared list and the two
// can't silently drift apart.
const PERMISSIONS: Partial<Record<FlagKey, { label: string; hint: string }>> = {
    allowSaveToLibrary: { label: "Saving Videos", hint: "Save a video from Search into the Library." },
    allowSaveAll: { label: "Bulk Save", hint: "Save every current search result at once (needs Saving Videos too)." },
    allowDeletionLibrary: { label: "Deleting Videos", hint: "Remove a video from the Library." },
    allowSummarizeAll: { label: "Bulk Summarize", hint: "Generate an AI summary for every video in the Library at once." },
    editAttachments: { label: "Attachments & Links", hint: "Add or remove a video's attachments and web links." },
    allowEditTermsAndTags: { label: "Terms & Tags", hint: "Add or remove a video's Terms and Tags." },
    allowEditSummary: { label: "AI Summaries", hint: "Edit a video's AI-generated summary." },
    allowEditTranscript: { label: "Transcripts", hint: "Edit a video's transcript." },
    allowEditTranscriptOnNA: { label: "Cleared Transcripts", hint: "Edit a transcript that was cleared to N/A after summarizing." },
    allowEditWDBS: { label: "Drive Assignment", hint: "Assign, change, or symlink a saved video's Drive category." },
    allowEditDriveLinking: { label: "Drive Editing UI", hint: "The Drive pencil editor and Bulk Assign Mode." },
    allowEditSequences: { label: "Sequence Reordering", hint: "Reorder or remove one video at a time from a sequence." },
    allowEditVideosInSequenceList: { label: "Sequence Building", hint: "Add Videos, Add to the End, and Clear Sequence." },
    allowModificationGlossary: { label: "Glossary", hint: "Add, edit, or delete Terms and Tags in the Glossary itself." },
    allowEditBio: { label: "Biographies", hint: "Edit a creator's biography." },
};

const ROWS = READ_ONLY_OVERRIDE_KEYS.filter(key => key in PERMISSIONS).map(key => ({ key, ...PERMISSIONS[key]! }));

/** Settings > Workspace > Advanced > Permissions: a master Read-only switch, plus every
 *  content-editing flag individually (see lib/flags.ts's READ_ONLY_OVERRIDE_KEYS — this list and
 *  what Read-only forces off are the same list by construction). Reads and writes the Settings
 *  table directly, the same way every other Settings screen does; a sync server's policy lock
 *  (useLockedSettings) disables a row exactly like it disables any other control here. */
export function PermissionsPanel() {
    const { reload } = useFlags();
    const isLocked = useLockedSettings();
    const [values, setValues] = useState<Record<string, boolean> | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [savingKey, setSavingKey] = useState<string | null>(null);

    const allKeys = ['workspaceReadOnly', ...ROWS.map(r => r.key)];

    const load = () => {
        getSettings(allKeys)
            .then(raw => setValues(Object.fromEntries(allKeys.map(k => [k, raw[k] === 'true']))))
            .catch(e => setError(typeof e === 'string' ? e : e?.message ?? 'Could not load permissions.'));
    };
    useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const set = async (key: string, next: boolean) => {
        setSavingKey(key);
        setError(null);
        // Shown at once; a failed write below is caught by re-reading the real stored value.
        setValues(prev => (prev ? { ...prev, [key]: next } : prev));
        try {
            await setSetting(key, next.toString());
            // Every screen in the app reads flags from this one context — this is what makes a
            // Read-only toggle (or any row here) take effect immediately, everywhere, not just
            // in this panel.
            await reload();
        } catch (e) {
            setError(typeof e === 'string' ? e : (e as Error)?.message ?? `Could not save "${key}".`);
            load();
        } finally {
            setSavingKey(null);
        }
    };

    if (values === null) {
        return error ? <ErrorBox>{error}</ErrorBox> : <p className="text-xs text-[#666666]">Loading permissions...</p>;
    }
    const readOnly = values.workspaceReadOnly;

    return (
        <div className="space-y-5">
            <label className="flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition-colors bg-[#121212] border-[#303030] hover:border-[#404040]">
                <input
                    type="checkbox"
                    checked={readOnly}
                    disabled={isLocked('workspaceReadOnly') || savingKey === 'workspaceReadOnly'}
                    onChange={e => set('workspaceReadOnly', e.target.checked)}
                    className="mt-1 shrink-0 cursor-pointer"
                    title={isLocked('workspaceReadOnly') ? LOCKED_TITLE : undefined}
                />
                <span>
                    <span className="flex items-center gap-1.5 text-sm font-bold text-white">
                        <Shield className="w-3.5 h-3.5 text-gray-400" />
                        Set Workspace to Read-only
                    </span>
                    <span className="block text-[11px] text-[#aaaaaa] leading-relaxed mt-1 max-w-md">
                        Turns off every permission below, plus History Search. Switching it
                        off restores what each was set to.
                    </span>
                </span>
            </label>

            <div>
                <h4 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Specific Permissions</h4>
                <div className="divide-y divide-[#232323] border border-[#232323] rounded-xl overflow-hidden">
                    {ROWS.map(({ key, label, hint }) => {
                        const locked = isLocked(key);
                        const disabled = locked || readOnly || savingKey === key;
                        return (
                            <label
                                key={key}
                                className={`flex items-start gap-3 px-4 py-3 bg-[#121212] transition-colors ${disabled ? 'opacity-50' : 'hover:bg-[#161616] cursor-pointer'}`}
                                title={locked ? LOCKED_TITLE : readOnly ? 'Overridden off by Read-only, above' : undefined}
                            >
                                <input
                                    type="checkbox"
                                    checked={values[key]}
                                    disabled={disabled}
                                    onChange={e => set(key, e.target.checked)}
                                    className="mt-0.5 shrink-0"
                                />
                                <span>
                                    <span className="block text-xs font-bold text-white">{label}</span>
                                    <span className="block text-[11px] text-[#888888] mt-0.5">{hint}</span>
                                </span>
                            </label>
                        );
                    })}
                </div>
            </div>

            {error && <ErrorBox>{error}</ErrorBox>}
        </div>
    );
}
