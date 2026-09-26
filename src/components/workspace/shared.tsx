import { useEffect, useRef, useState } from "react";
import { AlertTriangle, HardDrive } from "lucide-react";
import { checkWorkspaceName, selectFolder, type NameCheck } from "../../api";
import { LifeLoader } from "../LifeLoader";
import { fieldLabel, inputClass, secondaryBtn } from "./helpers";

/** What shows while something long runs: the Game of Life animation and the latest progress message. */
export function ProgressLine({ message }: { message: string }) {
    return (
        <div
            role="status"
            aria-label={message}
            className="px-3 py-2 rounded-lg border flex items-center gap-3"
            style={{ backgroundColor: "var(--k-bg)", borderColor: "var(--k-border-303030)" }}
        >
            <LifeLoader />
            <span className="min-w-0 text-[10px] font-bold uppercase tracking-wider break-words" style={{ color: "var(--k-accent)" }}>{message}</span>
        </div>
    );
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
    return <div className="p-3 bg-red-900/20 border border-red-500/30 rounded-lg text-red-400 text-xs break-words">{children}</div>;
}

interface NameFieldProps {
    value: string;
    onChange: (name: string) => void;
    /** Reports whether the name is usable and, if it's only taken, that it is. */
    onCheck: (check: NameCheck | null) => void;
    disabled?: boolean;
    /** An existing workspace's name isn't a problem (importing adds to it): shown as a note, not an error. */
    allowExisting?: boolean;
    /** Lets the caller show its own follow-up under the box. */
    children?: (check: NameCheck | null) => React.ReactNode;
}

/** The workspace name box: checks as you type that it's a legal folder name and not already used. */
export function NameField({ value, onChange, onCheck, disabled, allowExisting, children }: NameFieldProps) {
    const [check, setCheck] = useState<NameCheck | null>(null);
    const seq = useRef(0);
    useEffect(() => {
        const mine = ++seq.current;
        const timer = setTimeout(async () => {
            try {
                const result = await checkWorkspaceName(value);
                if (mine !== seq.current) return;
                setCheck(result);
                onCheck(result);
            } catch {
                if (mine === seq.current) { setCheck(null); onCheck(null); }
            }
        }, 200);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    const taken = !!check?.taken;
    const problem = !!check && !check.ok && !(allowExisting && taken);
    return (
        <div>
            <label className={fieldLabel}>Workspace name</label>
            <input
                className={inputClass}
                value={value}
                maxLength={64}
                disabled={disabled}
                spellCheck={false}
                onChange={(e) => onChange(e.target.value)}
                placeholder="New Workspace"
            />
            {problem && (
                <p className="text-[11px] text-red-400 mt-1.5 flex items-center gap-1.5">
                    <AlertTriangle className="w-3 h-3 shrink-0" />
                    <span>{check!.error}</span>
                    {taken && (
                        <button type="button" onClick={() => onChange(check!.suggestion)} className="underline text-white hover:opacity-80 cursor-pointer">
                            Use "{check!.suggestion}"
                        </button>
                    )}
                </p>
            )}
            {!problem && (
                <p className="text-[11px] text-[#666666] mt-1.5">Letters, numbers and spaces. It becomes the workspace's folder name.</p>
            )}
            {children?.(check)}
        </div>
    );
}

interface LocationProps {
    defaultLocation: string;
    value: string | null;
    onChange: (path: string | null) => void;
    disabled?: boolean;
}

/** Where the workspace's data is kept: the app folder, or a folder of the user's choosing (an external drive). */
export function StorageLocation({ defaultLocation, value, onChange, disabled }: LocationProps) {
    const choose = async () => {
        const folder = await selectFolder(value ?? undefined);
        if (folder) onChange(folder);
    };
    return (
        <div>
            <label className={fieldLabel}>Stored in</label>
            <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 bg-black/40 border border-[#303030] px-3 py-2.5 rounded-lg text-[11px] text-[#888888] break-all font-mono">
                    {value ? value : defaultLocation}
                </code>
                <button type="button" onClick={choose} disabled={disabled} className={`${secondaryBtn} shrink-0 !px-3`}>
                    <HardDrive className="w-4 h-4" />
                    {value ? "Change" : "Another drive"}
                </button>
                {value && (
                    <button type="button" onClick={() => onChange(null)} disabled={disabled} className="text-[11px] text-[#aaaaaa] hover:text-white underline cursor-pointer shrink-0">
                        Reset
                    </button>
                )}
            </div>
            <p className="text-[11px] text-[#666666] mt-1.5">
                {value
                    ? "A folder with the workspace's name is made inside it. Kinesis remembers the location, and the workspace shows as unavailable while the drive is unplugged."
                    : "Kept with the app's own data. Choose another drive to keep it somewhere else."}
            </p>
        </div>
    );
}
