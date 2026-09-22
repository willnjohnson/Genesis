import { X } from "lucide-react";
import { createPortal } from "react-dom";

interface ConfirmDialogProps {
    message: string;
    onConfirm: () => void;
    onCancel: () => void;
    /** The confirm button's text; "Delete" unless the action is something else (e.g. "Remove"). */
    confirmLabel?: string;
    /** The heading; a generic "Please Confirm" unless the caller says what is being confirmed. */
    title?: string;
}

export function ConfirmDialog({ message, onConfirm, onCancel, confirmLabel = "Delete", title = "Please Confirm" }: ConfirmDialogProps) {
    // Rendered on the page itself, not inside whatever opened it: the video panel slides in with a CSS
    // transform, which would make a "fixed" dialog inside it position against the panel instead of the
    // window (and scroll the panel's contents when the dialog took focus).
    return createPortal(
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 animate-in fade-in duration-200"
            // Stops here, so clicking outside the dialog dismisses only the dialog, not a window it was opened from.
            onClick={(e) => { e.stopPropagation(); onCancel(); }}
        >
            <div
                className="bg-[#0f0f0f] border border-[#303030] rounded-lg p-6 max-w-md mx-4 animate-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start justify-between mb-4">
                    <h3 className="text-lg font-bold text-white">{title}</h3>
                    <button
                        onClick={onCancel}
                        className="text-[#aaaaaa] hover:text-white cursor-pointer transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Line breaks in a message are kept, and a long unbroken word (a web address) wraps instead of overflowing. */}
                <p className="text-[#aaaaaa] mb-6 leading-relaxed whitespace-pre-line break-words">{message}</p>

                <div className="flex gap-3 justify-end">
                    <button
                        onClick={onCancel}
                        className="px-4 py-2 rounded-lg bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] cursor-pointer text-white text-sm font-semibold transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={onConfirm}
                        className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 cursor-pointer text-white text-sm font-semibold transition-colors"
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
