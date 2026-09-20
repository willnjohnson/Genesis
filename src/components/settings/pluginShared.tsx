import { Check, Save, Terminal, Lightbulb } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useFlags } from "../../hooks/useFlags";

// Pieces shared by the Plugins tab (Ollama, the Cloud tab) and the API Key tab's Venice AI page.

export function PromptEditor({
    label,
    value,
    onChange,
    onSave,
    dirty,
    hint,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    onSave: () => void;
    dirty: boolean;
    /** Shown beside the label (a tooltip about the variables a prompt can use, say). */
    hint?: React.ReactNode;
}) {
    // A DB owner can make the prompt templates read-only (allowEditPrompts = false).
    const { flags } = useFlags();
    const canEdit = flags.allowEditPrompts;
    return (
        <div>
            <div className="flex items-center gap-2 mb-2">
                <label className="text-[10px] uppercase font-bold text-[#aaaaaa] tracking-widest block">{label}</label>
                {hint}
            </div>
            <textarea
                value={value}
                readOnly={!canEdit}
                onChange={(e) => onChange(e.target.value)}
                placeholder="Create a synopsis of this video transcript with pretty format."
                className="w-full h-80 bg-[#1a1a1a] border border-[#303030] text-sm text-white rounded-lg px-3 py-2.5 outline-none hover:bg-[#202020] transition-colors resize-y font-mono text-[11px]"
            />
            <div className="flex items-center justify-between mt-2">
                {canEdit && dirty && (
                    <button
                        onClick={onSave}
                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-[11px] font-bold transition-colors cursor-pointer"
                    >
                        <Save className="w-3 h-3" />
                        Save
                    </button>
                )}
            </div>
        </div>
    );
}

export function DefaultBadge() {
    return (
        <div className="flex items-center gap-2 px-4 py-2 bg-green-500/10 border border-green-500/30 text-green-400 rounded-lg text-[11px] font-bold">
            <Check className="w-3 h-3" />
            Default
        </div>
    );
}

export function TooltipLightbulb() {
    const [isHovered, setIsHovered] = useState(false);
    const [rect, setRect] = useState<DOMRect | null>(null);

    return (
        <div
            className="relative flex items-center"
            onMouseEnter={(e) => {
                setRect(e.currentTarget.getBoundingClientRect());
                setIsHovered(true);
            }}
            onMouseLeave={() => setIsHovered(false)}
        >
            <Lightbulb className="w-3.5 h-3.5 text-[#666666] hover:text-orange-400 transition-colors cursor-help" />
            {isHovered && rect && createPortal(
                <div
                    className="fixed z-[999999] w-80 bg-[#1a1a1a] shadow-2xl p-4 rounded-xl border border-[#333] pointer-events-none animate-in fade-in slide-in-from-bottom-2 duration-200"
                    style={{
                        top: rect.top - 12,
                        left: rect.left,
                        transform: 'translateY(-100%)'
                    }}
                >
                    <h4 className="text-[11px] font-bold text-gray-500 uppercase tracking-widest mb-3 border-b border-[#333] pb-2 flex items-center gap-2">
                        <Terminal className="w-3.5 h-3.5" />
                        Supported Variables
                    </h4>
                    <div className="space-y-4">
                        <div className="grid grid-cols-1 gap-1.5 pt-1 text-[11px]">
                            <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                <span>{"${title}"}:</span>
                                <span className="text-gray-500 group-hover/code:text-gray-300">Video title</span>
                            </code>
                            <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                <span>{"${author}"}:</span>
                                <span className="text-gray-500 group-hover/code:text-gray-300">Channel name</span>
                            </code>
                            <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                <span>{"${handle}"}:</span>
                                <span className="text-gray-500 group-hover/code:text-gray-300">Channel handle</span>
                            </code>
                            <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                <span>{"${length_seconds}"}:</span>
                                <span className="text-gray-500 group-hover/code:text-gray-300">Video length</span>
                            </code>
                            <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                <span>{"${view_count}"}:</span>
                                <span className="text-gray-500 group-hover/code:text-gray-300">View count</span>
                            </code>
                        </div>
                        <p className="text-[10px] text-gray-400 leading-relaxed italic">
                            These variables substitute dynamically when generating a summary from the library.
                        </p>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}
