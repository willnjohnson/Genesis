interface Props {
    on: boolean;
    onChange: () => void;
    /** The control's name for screen readers, when it isn't labelled by text next to it. */
    label?: string;
    disabled?: boolean;
    /** Hover text (Settings uses it to say a setting is locked by the sync server). */
    title?: string;
}

/** The on/off switch every Settings page uses (the accent color when on), so they all look the same. */
export function Toggle({ on, onChange, label, disabled, title }: Props) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={label}
            disabled={disabled}
            title={title}
            onClick={onChange}
            className={`w-12 h-6 rounded-full transition-colors relative cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-default ${on ? 'bg-red-600' : 'bg-[#303030]'}`}
        >
            <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${on ? 'left-7' : 'left-1'}`} />
        </button>
    );
}
