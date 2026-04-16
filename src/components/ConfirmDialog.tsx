import { X } from "lucide-react";

interface ConfirmDialogProps {
    message: string;
    onConfirm: () => void;
    onCancel: () => void;
}

export function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
    return (
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 animate-in fade-in duration-200"
            onClick={onCancel}
        >
            <div
                className="bg-[#0f0f0f] border border-[#303030] rounded-lg p-6 max-w-md mx-4 animate-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start justify-between mb-4">
                    <h3 className="text-lg font-bold text-white">Please Confirm</h3>
                    <button
                        onClick={onCancel}
                        className="text-[#aaaaaa] hover:text-white cursor-pointer transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <p className="text-[#aaaaaa] mb-6 leading-relaxed">{message}</p>

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
                        Delete
                    </button>
                </div>
            </div>
        </div>
    );
}


