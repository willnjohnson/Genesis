import { useState } from "react";
import { Info, PackageOpen } from "lucide-react";
import {
    importKinpak, inspectKinpak, selectKinpakFile,
    type ImportedWorkspace, type KinpakPreview, type NameCheck,
} from "../../api";
import { ErrorBox, NameField, ProgressLine, StorageLocation } from "./shared";
import { errText, primaryBtn, reloadApp, secondaryBtn, useKinpakProgress } from "./helpers";

interface Props {
    defaultLocation: string;
    onBack?: () => void;
}

// What the pack holds, in the words the rest of the app uses. Kinds not listed aren't shown.
const COUNT_LABELS: [string, string][] = [
    ["video", "videos"], ["wdbs", "categories"], ["glossary", "glossary terms"], ["biography", "bios"],
    ["custom_prompt", "custom prompts"], ["video_note", "notes"], ["attachment", "attachments"], ["history", "searches"],
];

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function describeCounts(counts: Record<string, number>): string {
    const parts = COUNT_LABELS.filter(([k]) => (counts[k] ?? 0) > 0).map(([k, label]) => `${counts[k].toLocaleString()} ${label}`);
    return parts.length ? parts.join(", ") : "No content, just settings";
}

/**
 * Import a kinpak. Under a new name it becomes a new workspace; under the name of a workspace that
 * already exists it's added to that one (after a heads-up), keeping everything that's already there.
 * Nothing is ever replaced or deleted.
 */
export function ImportKinpakPanel({ defaultLocation, onBack }: Props) {
    const [file, setFile] = useState<string | null>(null);
    const [preview, setPreview] = useState<KinpakPreview | null>(null);
    const [name, setName] = useState("");
    const [check, setCheck] = useState<NameCheck | null>(null);
    const [location, setLocation] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<ImportedWorkspace | null>(null);
    const progress = useKinpakProgress(busy);

    const choose = async () => {
        setError(null);
        try {
            const picked = await selectKinpakFile();
            if (!picked) return;
            const info = await inspectKinpak(picked);
            setFile(picked);
            setPreview(info);
            setName(info.suggestedName);
            setConfirming(false);
        } catch (e) {
            setError(errText(e));
        }
    };

    // A name a workspace already has means "add to it"; any other legal name makes a new one.
    const merging = !!check?.taken;
    const canImport = !!file && !busy && (!!check?.ok || merging);

    const run = async () => {
        if (!file) return;
        setBusy(true);
        setError(null);
        try {
            const done = await importKinpak(file, name, true, merging ? null : location);
            // Anything that couldn't be imported is worth reading before the app reloads into the workspace.
            if (done.summary.error_count > 0) {
                setResult(done);
                setBusy(false);
            } else {
                reloadApp();
            }
        } catch (e) {
            setError(errText(e));
            setBusy(false);
            setConfirming(false);
        }
    };

    // The button asks first when it would change a workspace that already exists.
    const start = () => (merging ? setConfirming(true) : run());

    if (result) {
        return (
            <div className="space-y-4">
                <h3 className="text-base font-bold">{result.merged ? "Added, with some problems" : "Imported, with some problems"}</h3>
                <div className="p-3 bg-green-900/10 border border-green-500/30 rounded-lg text-green-400 text-xs leading-relaxed">
                    {result.merged ? `Added to "${result.workspace.name}": ` : "The workspace was created: "}
                    {result.summary.imported.toLocaleString()} items came in.
                    <div className="mt-2 text-orange-400">
                        {result.summary.error_count} couldn't be imported:
                        <ul className="list-disc ml-4 mt-1 break-words">{result.summary.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                    </div>
                </div>
                <button onClick={reloadApp} className={`w-full ${primaryBtn}`}>Open the workspace</button>
            </div>
        );
    }

    return (
        <div className="space-y-5">
            <div>
                <h3 className="text-base font-bold">Import a Kinpak</h3>
                <p className="text-[11px] text-[#aaaaaa] leading-relaxed mt-1">
                    A .kinpak file becomes a workspace of its own, with its library, settings, names, history, notes and attachments. If a workspace
                    with the same name already exists, what's missing is added to it instead. API keys are never part of one.
                </p>
            </div>

            {!preview ? (
                <button onClick={choose} className={`w-full ${secondaryBtn}`}>
                    <PackageOpen className="w-4 h-4" />
                    Choose a .kinpak file
                </button>
            ) : (
                <>
                    <div className="bg-[#121212] border border-[#303030] rounded-xl p-4 space-y-1.5">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="text-sm font-bold truncate">{preview.workspaceName ?? fileName(file!)}</div>
                                <div className="text-[11px] text-[#888888] truncate">{fileName(file!)}</div>
                            </div>
                            <button onClick={choose} disabled={busy} className="text-[11px] text-[#aaaaaa] hover:text-white underline cursor-pointer shrink-0">Change file</button>
                        </div>
                        <div className="text-[11px] text-[#aaaaaa]">{describeCounts(preview.counts)}</div>
                        <div className="text-[11px] text-[#666666]">
                            Exported {new Date(preview.generatedAt).toLocaleDateString()}{preview.app ? ` by ${preview.app}` : ""}
                        </div>
                    </div>

                    <NameField value={name} onChange={(n) => { setName(n); setConfirming(false); }} onCheck={setCheck} disabled={busy} allowExisting>
                        {() => merging && (
                            <p className="text-[11px] text-orange-400 mt-1.5 flex items-start gap-1.5">
                                <Info className="w-3 h-3 shrink-0 mt-0.5" />
                                <span>A workspace named "{check!.name}" already exists, so this file will be added to it. Change the name to make a separate workspace instead.</span>
                            </p>
                        )}
                    </NameField>

                    {!merging && <StorageLocation defaultLocation={defaultLocation} value={location} onChange={setLocation} disabled={busy} />}

                    {confirming && (
                        <div className="p-4 bg-[#121212] border border-[#3f3f3f] rounded-xl space-y-3">
                            <div className="text-sm font-bold">Add to "{check!.name}"?</div>
                            <p className="text-[11px] text-[#aaaaaa] leading-relaxed">
                                What's in this file that "{check!.name}" doesn't have yet will be added to it. Everything already there is kept: nothing is
                                replaced or removed, and its settings and section names stay as they are. If a video or entry exists in both, the file's
                                details fill in what yours is missing.
                            </p>
                            <div className="flex gap-2">
                                <button onClick={() => setConfirming(false)} disabled={busy} className={secondaryBtn}>Cancel</button>
                                <button onClick={run} disabled={busy} className={`flex-1 ${primaryBtn}`}>
                                    <PackageOpen className="w-4 h-4" />
                                    {busy ? "Adding..." : `Add to "${check!.name}"`}
                                </button>
                            </div>
                        </div>
                    )}
                </>
            )}

            {busy && <ProgressLine message={progress ?? "Starting import..."} />}
            {error && <ErrorBox>{error}</ErrorBox>}
            {!confirming && (
                <div className="flex gap-2">
                    {onBack && <button onClick={onBack} disabled={busy} className={secondaryBtn}>Back</button>}
                    {preview && (
                        <button onClick={start} disabled={!canImport} className={`flex-1 ${primaryBtn}`}>
                            <PackageOpen className="w-4 h-4" />
                            {busy ? "Importing..." : merging ? "Add to existing workspace" : "Import"}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
