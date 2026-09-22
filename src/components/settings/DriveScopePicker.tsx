import { useEffect, useState } from "react";
import { getExportDrives, type DriveScopeOptions, type ExportDrive } from "../../api";
import { useWorkspace } from "../../hooks/useWorkspace";
import { CheckboxDropdown } from "../CheckboxDropdown";
import { ChoiceField } from "./ExportSection";

interface Props {
    value: DriveScopeOptions;
    onChange: (next: DriveScopeOptions) => void;
    disabled?: boolean;
    /** Which of the follow-up questions apply to what's being exported. */
    videos: boolean;
    glossary: boolean;
    /** Only a kinpak keeps links inside text; a vault always turns links to left-out items into plain text. */
    textLinks: boolean;
}

// Which Drives an export includes, and what to do with what touches a left-out one. One dropdown of
// checkboxes whose closed button already says what's chosen; every Drive is included until it's
// unticked, and the follow-up choices only appear once something is left out.
export function DriveScopePicker({ value, onChange, disabled, videos, glossary, textLinks }: Props) {
    const { labels } = useWorkspace();
    const [drives, setDrives] = useState<ExportDrive[]>([]);
    useEffect(() => {
        getExportDrives().then(setDrives).catch(() => {});
    }, []);

    if (drives.length === 0) return null;

    const drive = labels.aliasDriveName.toLowerCase();
    const nameOf = (d: ExportDrive) => d.alias || d.segment;
    const excluded = new Set(value.excluded);
    const included = drives.filter(d => !excluded.has(d.path));
    const leftOut = drives.length - included.length;
    const summary =
        leftOut === 0 ? `All ${drives.length} ${drive}s`
        : included.length === 0 ? `None of ${drives.length}`
        : included.length <= 2 ? included.map(nameOf).join(", ")
        : `${included.length} of ${drives.length} ${drive}s`;

    return (
        <div className="space-y-2.5">
            <div className="space-y-1">
                <span className="block text-[11px] text-[#aaaaaa]">{labels.aliasDriveName}s to include</span>
                <CheckboxDropdown
                    options={drives.map(d => ({
                        value: d.path,
                        label: nameOf(d),
                        hint: d.alias ? `${d.segment} (${d.alias})` : d.segment,
                        detail: d.videos.toLocaleString(),
                    }))}
                    selected={included.map(d => d.path)}
                    onChange={(next) => onChange({ ...value, excluded: drives.filter(d => !next.includes(d.path)).map(d => d.path) })}
                    summary={summary}
                    disabled={disabled}
                    allNone
                />
            </div>

            {leftOut > 0 && (
                <div className="space-y-2.5 pl-3 border-l-2 border-[#2f2f2f]">
                    {glossary && (
                        <ChoiceField
                            label={`Terms filed under a ${drive} you left out`}
                            value={value.terms}
                            disabled={disabled}
                            onChange={(terms) => onChange({ ...value, terms })}
                            options={[
                                { value: "keep", label: "Keep them, without that " + drive },
                                { value: "drop", label: "Leave out those filed only there" },
                            ]}
                        />
                    )}
                    {videos && (
                        <ChoiceField
                            label={`Videos based in a ${drive} you left out`}
                            value={value.keepUnlinkedVideos ? "all" : value.keepLinkedVideos ? "linked" : "none"}
                            disabled={disabled}
                            onChange={(v) => onChange({ ...value, keepLinkedVideos: v !== "none", keepUnlinkedVideos: v === "all" })}
                            options={[
                                { value: "linked", label: `Keep those linked into a ${drive} you keep (based there)` },
                                { value: "none", label: "Leave them all out" },
                                { value: "all", label: "Keep them all (the unlinked ones become uncategorized)" },
                            ]}
                        />
                    )}
                    {textLinks && (
                        <ChoiceField
                            label="Links in text to anything left out"
                            value={value.unlinkText ? "plain" : "keep"}
                            disabled={disabled}
                            onChange={(v) => onChange({ ...value, unlinkText: v === "plain" })}
                            options={[
                                { value: "plain", label: "Turn into plain text" },
                                { value: "keep", label: "Leave as they are" },
                            ]}
                        />
                    )}
                    <p className="text-[11px] text-[#666666] leading-relaxed">
                        A creator whose videos are all left out goes too, with their bio and custom prompt. Anything not filed under a {drive} is always included.
                    </p>
                </div>
            )}
        </div>
    );
}
