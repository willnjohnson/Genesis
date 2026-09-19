import { useState, useEffect, useRef } from 'react';
import type { ChangeEvent, MouseEvent } from 'react';
import { Check, Trash2, Upload, Copy } from 'lucide-react';
import { type DisplaySettings } from '../../api';
import { useLockedSettings, LOCKED_TITLE } from '../../hooks/useLockedSettings';
import { useFlags } from '../../hooks/useFlags';
import {
    BUILTIN_THEMES, applyTheme, loadCustomThemes, saveCustomThemes,
    parseThemeJson, isThemeError, resolveTheme, type Theme,
} from '../../lib/themes';

interface Props {
    settings: DisplaySettings;
    onUpdate: (updates: Partial<DisplaySettings>) => void;
}

/**
 * Settings > Theme — its own top-level tab (not nested under Display, per the request). Lists
 * every built-in palette (see lib/themes.ts's BUILTIN_THEMES) plus whatever the user has imported,
 * and lets them import a new one from a small JSON file. Selecting a theme applies it immediately
 * (lib/themes.ts's applyTheme, setting CSS custom properties on <html>) and persists the choice
 * through the same `theme` field/onUpdate callback DisplayTab's old toggle used to.
 */
export function ThemeTab({ settings, onUpdate }: Props) {
    const [customThemes, setCustomThemes] = useState<Theme[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        loadCustomThemes().then(setCustomThemes).finally(() => setLoading(false));
    }, []);

    const activeName = settings.theme;
    const isLocked = useLockedSettings();
    // The server enforces either the active theme or the custom theme list itself.
    const themeLocked = isLocked('theme');
    const themesLocked = themeLocked || isLocked('customThemes');
    // A DB owner can switch off importing, copying a template and deleting custom themes altogether.
    const { flags } = useFlags();
    const customAllowed = flags.allowCustomThemes;

    const handleSelect = (theme: Theme) => {
        if (themeLocked) return;
        applyTheme(theme);
        onUpdate({ theme: theme.name });
    };

    const handleImportClick = () => {
        if (themesLocked || !customAllowed) return;
        setError(null);
        fileInputRef.current?.click();
    };

    // Mirrors the plain <input type="file"> + FileReader pattern PhotosynthesisPanel.tsx already
    // uses for image uploads — no Tauri file-dialog plugin needed just to read a small JSON file.
    const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            const text = typeof reader.result === 'string' ? reader.result : '';
            const fallbackName = file.name.replace(/\.json$/i, '');
            const result = parseThemeJson(text, fallbackName);
            if (isThemeError(result)) {
                setError(result.error);
                return;
            }
            setError(null);
            // Re-importing the same theme replaces the old copy instead of duplicating it.
            const next = [...customThemes.filter(t => t.name !== result.name), result];
            setCustomThemes(next);
            await saveCustomThemes(next);
            handleSelect(result);
        };
        reader.onerror = () => setError("Couldn't read that file.");
        reader.readAsText(file);
    };

    // Gives a copy-pasteable starting point for a custom theme file — Solarized's own values,
    // since it's a real, recognizable palette rather than a made-up placeholder, so whoever's
    // editing it can see immediately which fields map to which visual role before changing them.
    const handleCopyTemplate = async () => {
        const solarized = BUILTIN_THEMES.find(t => t.name === 'solarized');
        if (!solarized) return;
        const template = { name: 'My Custom Theme', scheme: solarized.scheme, colors: solarized.colors };
        try {
            await navigator.clipboard.writeText(JSON.stringify(template, null, 2));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            setError("Couldn't copy to clipboard.");
        }
    };

    const handleDelete = async (theme: Theme, e: MouseEvent) => {
        e.stopPropagation();
        if (themesLocked || !customAllowed) return;
        const next = customThemes.filter(t => t.name !== theme.name);
        setCustomThemes(next);
        await saveCustomThemes(next);
        // Deleting the active theme falls back to Dark rather than leaving a dangling selection.
        if (activeName === theme.name) {
            handleSelect(resolveTheme(undefined, next));
        }
    };

    const allThemes = [...BUILTIN_THEMES, ...customThemes];

    return (
        <div className="space-y-8 animate-in slide-in-from-right-4 duration-300">
            <div>
                <h3 className="text-base font-bold mb-2">Theme</h3>
                <p className="text-xs text-[#aaaaaa] mb-6">
                    {themeLocked ? "Your theme is managed by your sync server." : "Choose a color theme, or import your own."}
                </p>

                {loading ? (
                    <div className="text-center text-gray-500 text-xs py-8">Loading...</div>
                ) : (
                    <div className="grid grid-cols-2 gap-2">
                        {allThemes.map(theme => (
                            <button
                                key={theme.name}
                                onClick={() => handleSelect(theme)}
                                disabled={themeLocked}
                                title={themeLocked ? LOCKED_TITLE : undefined}
                                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-all cursor-pointer disabled:cursor-default disabled:opacity-60 ${activeName === theme.name ? 'border-[var(--k-accent)] bg-[#303030]' : 'border-[#303030] bg-[#121212] hover:border-[#505050]'}`}
                            >
                                {/* Tricolor pill: background | surface | accent, left to right. The mid-gray
                                    outline and dividers stay visible on both very dark and very light
                                    colors, so neighboring segments (or the pill and the card) never blend. */}
                                <span className="flex w-10 h-4 rounded-[8px_2px_8px_2px] overflow-hidden border border-[#808080]/35 shrink-0">
                                    <span className="flex-1" style={{ backgroundColor: theme.colors.bg }} />
                                    <span className="w-px bg-[#808080]/35" />
                                    <span className="flex-1" style={{ backgroundColor: theme.colors.surface }} />
                                    <span className="w-px bg-[#808080]/35" />
                                    <span className="flex-1" style={{ backgroundColor: theme.colors.accent }} />
                                </span>
                                <span className="flex-1 text-sm font-semibold text-white truncate">{theme.label}</span>
                                {activeName === theme.name && <Check className="w-4 h-4 text-[var(--k-accent)] shrink-0" />}
                                {!theme.builtin && customAllowed && (
                                    <button
                                        onClick={(e) => handleDelete(theme, e)}
                                        title="Remove theme"
                                        className="text-gray-500 hover:text-red-400 transition-colors cursor-pointer p-0.5 shrink-0"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                )}
                            </button>
                        ))}
                    </div>
                )}

                {customAllowed && (
                <div className="mt-4 flex flex-wrap gap-2">
                    <button
                        onClick={handleImportClick}
                        disabled={themesLocked}
                        title={themesLocked ? LOCKED_TITLE : undefined}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-[#404040] text-sm font-semibold text-[#aaaaaa] hover:text-white hover:border-[#505050] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
                    >
                        <Upload className="w-4 h-4" />
                        Import Theme
                    </button>
                    <button
                        onClick={handleCopyTemplate}
                        title="Copy a Solarized-based JSON template to the clipboard to use as a starting point"
                        className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-[#404040] text-sm font-semibold text-[#aaaaaa] hover:text-white hover:border-[#505050] transition-colors cursor-pointer"
                    >
                        {copied ? <Check className="w-4 h-4 text-[var(--k-success)]" /> : <Copy className="w-4 h-4" />}
                        {copied ? 'Copied!' : 'Copy Template'}
                    </button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="application/json,.json"
                        onChange={handleFileChange}
                        className="hidden"
                    />
                </div>
                )}

                {error && (
                    <div className="mt-3 text-[10px] text-red-400 bg-red-900/20 border border-red-500/30 rounded-md px-2 py-1.5">
                        {error}
                    </div>
                )}
            </div>
        </div>
    );
}
