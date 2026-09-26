import type { ElementType, FormEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * The app's dialog: a dimmed full-window backdrop with a centered panel, a header (icon, title, close
 * button), a scrolling body and an optional footer. Every dialog draws it this way so their sizes,
 * dimming, corners and stacking match.
 *
 * It's drawn on the page itself (a portal), not inside whatever opened it: the video panel slides in
 * with a CSS transform, which would make a "fixed" dialog inside it position against the panel
 * instead of the window. Clicking the backdrop closes it, and so does Esc, which App.tsx does by
 * "clicking" the topmost backdrop, so `onClose` is the one way out.
 */

const WIDTHS = {
    /** Short forms and confirmations. */
    sm: 'max-w-md',
    /** Reading a definition. */
    lg: 'max-w-3xl',
    /** A form with a big text area. */
    xl: 'max-w-4xl',
    /** A full-size reader. */
    full: 'max-w-7xl',
} as const;

interface Props {
    onClose: () => void;
    title?: ReactNode;
    /** A smaller line under the title. */
    subtitle?: ReactNode;
    icon?: ElementType;
    /** More in the header row, right after the title (a badge, say). */
    headerExtra?: ReactNode;
    size?: keyof typeof WIDTHS;
    /** 'top' for a dialog that opens over other dialogs (a confirmation), 'base' otherwise. */
    layer?: 'base' | 'top';
    /** Renders the panel as a <form>, so Enter in a field submits it. */
    onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
    /** Buttons for a bar along the bottom. */
    footer?: ReactNode;
    /** Extra classes for the panel (a fixed height, say). */
    className?: string;
    /** Extra classes for the scrolling body; it has `p-6` unless this says otherwise. */
    bodyClassName?: string;
    children: ReactNode;
}

export function Modal({
    onClose, title, subtitle, icon: Icon, headerExtra, size = 'sm', layer = 'base',
    onSubmit, footer, className = '', bodyClassName = 'p-6', children,
}: Props) {
    const panelClass = `bg-[#0f0f0f] border border-[#303030] rounded-2xl w-full ${WIDTHS[size]} max-h-[90vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 ${className}`;
    const inner = (
        <>
            {(title || Icon) && (
                <div className="px-6 py-4 border-b border-[#303030] flex items-center justify-between gap-4 bg-[#141414] shrink-0">
                    <div className="flex items-center gap-3 min-w-0 text-gray-200">
                        {Icon && <Icon className="w-5 h-5 text-gray-400 shrink-0" />}
                        <div className="min-w-0">
                            <h2 className="text-lg font-bold truncate">{title}</h2>
                            {subtitle && <p className="text-xs text-gray-400 truncate">{subtitle}</p>}
                        </div>
                        {headerExtra}
                    </div>
                    <button type="button" onClick={onClose} className="text-gray-500 hover:text-white transition-colors cursor-pointer shrink-0" aria-label="Close">
                        <X className="w-5 h-5" />
                    </button>
                </div>
            )}
            <div className={`flex-1 min-h-0 overflow-y-auto ${bodyClassName}`}>{children}</div>
            {footer && <div className="px-6 py-4 border-t border-[#303030] flex justify-end gap-3 bg-[#141414] shrink-0">{footer}</div>}
        </>
    );
    return createPortal(
        <div
            className={`fixed inset-0 ${layer === 'top' ? 'z-[200]' : 'z-[100]'} flex items-center justify-center bg-black/80 p-4 animate-in fade-in duration-200`}
            // Stops here, so clicking outside closes only this dialog, not one it was opened from.
            onClick={(e) => { e.stopPropagation(); onClose(); }}
        >
            {onSubmit ? (
                <form onSubmit={onSubmit} onClick={(e) => e.stopPropagation()} className={panelClass}>{inner}</form>
            ) : (
                <div onClick={(e) => e.stopPropagation()} className={panelClass}>{inner}</div>
            )}
        </div>,
        document.body,
    );
}
