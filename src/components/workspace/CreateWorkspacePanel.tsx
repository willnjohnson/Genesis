import { useEffect, useState } from "react";
import { FolderPlus } from "lucide-react";
import { checkWorkspaceName, createWorkspace, type NameCheck } from "../../api";
import { ErrorBox, NameField, StorageLocation } from "./shared";
import { errText, primaryBtn, reloadApp, secondaryBtn } from "./helpers";

interface Props {
    defaultLocation: string;
    onBack: () => void;
}

export function CreateWorkspacePanel({ defaultLocation, onBack }: Props) {
    const [name, setName] = useState("");
    const [check, setCheck] = useState<NameCheck | null>(null);
    const [location, setLocation] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Offer a free name to start from ("New Workspace", or numbered when that's taken).
    useEffect(() => {
        checkWorkspaceName("New Workspace").then(c => setName(c.ok ? c.name : c.suggestion)).catch(() => setName("New Workspace"));
    }, []);

    const create = async () => {
        setBusy(true);
        setError(null);
        try {
            await createWorkspace(name, location);
            reloadApp(name);
        } catch (e) {
            setError(errText(e));
            setBusy(false);
        }
    };

    return (
        <div className="space-y-5">
            <div>
                <h3 className="text-base font-bold">Create a new workspace</h3>
                <p className="text-[11px] text-[#aaaaaa] leading-relaxed mt-1">
                    An empty library with its own settings, history and names. You can rename it later.
                </p>
            </div>
            <NameField value={name} onChange={setName} onCheck={setCheck} disabled={busy} />
            <StorageLocation defaultLocation={defaultLocation} value={location} onChange={setLocation} disabled={busy} />
            {error && <ErrorBox>{error}</ErrorBox>}
            <div className="flex gap-2">
                <button onClick={onBack} disabled={busy} className={secondaryBtn}>Back</button>
                <button onClick={create} disabled={busy || !check?.ok} className={`flex-1 ${primaryBtn}`}>
                    <FolderPlus className="w-4 h-4" />
                    {busy ? "Creating..." : "Create workspace"}
                </button>
            </div>
        </div>
    );
}
