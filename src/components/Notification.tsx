import { useEffect, useState } from "react";
import { X, Check, Info } from "lucide-react";

export type NotificationType = "success" | "info" | "error";

interface NotificationProps {
    message: string;
    type?: NotificationType;
    onClose: () => void;
    duration?: number;
}

export function Notification({ message, type = "info", onClose, duration = 3000 }: NotificationProps) {
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        // Small delay to allow enter animation
        requestAnimationFrame(() => setIsVisible(true));

        if (duration > 0) {
            const timer = setTimeout(() => {
                setIsVisible(false);
                setTimeout(onClose, 300); // Wait for exit animation
            }, duration);
            return () => clearTimeout(timer);
        }
    }, [duration, onClose]);

    const typeStyles =
        type === "success" ? "border-green-500 text-green-400" :
            type === "error" ? "border-red-500 text-red-400" :
                "border-blue-500 text-blue-400"; // Info

    const Icon =
        type === "success" ? Check :
            type === "error" ? X :
                Info;

    return (
        <div
            className={`fixed bottom-6 left-6 z-[100] flex items-center gap-3 px-5 py-3 rounded-xl border bg-[#121212] border-[#303030] transition-all duration-300 transform ${isVisible ? "translate-y-0 opacity-100 scale-100" : "translate-y-4 opacity-0 scale-95"
                } ${typeStyles}`}
        >
            <Icon className="w-5 h-5 flex-shrink-0" />
            <span className="font-semibold text-sm tracking-tight text-white">{message}</span>
            <button onClick={() => setIsVisible(false)} className="opacity-50 hover:opacity-100 transition-opacity ml-2 text-[#aaaaaa] cursor-pointer hover:text-white">
                <X className="w-4 h-4" />
            </button>
        </div>
    );
}
