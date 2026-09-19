import { LayoutGrid, List, AlignJustify, AlignLeft } from "lucide-react";
import { BRAND } from "../../branding";
import { type DisplaySettings } from "../../api";
import { useLockedSettings, LOCKED_TITLE } from "../../hooks/useLockedSettings";

const RESOLUTIONS = [
    "600x600", "800x600", "1024x768", "1280x720",
    "1440x900", "1600x900", "1920x1080", "2560x1440",
];

interface Props {
    settings: DisplaySettings;
    currentVideoListMode: 'grid' | 'compact';
    currentNavigationOrientation: 'horizontal' | 'vertical';
    onUpdate: (updates: Partial<DisplaySettings>) => void;
}

/** A simple toggle-switch button */
function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
    return (
        <button
            onClick={onChange}
            className={`w-12 h-6 rounded-full transition-colors relative cursor-pointer ${on ? 'bg-red-600' : 'bg-[#303030]'}`}
        >
            <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${on ? 'left-7' : 'left-1'}`} />
        </button>
    );
}

export function DisplayTab({ settings, currentVideoListMode, currentNavigationOrientation, onUpdate }: Props) {
    const isLocked = useLockedSettings();
    const listLocked = isLocked('video_list_mode');
    const navLocked = isLocked('navigation_orientation');
    return (
        <div className="space-y-8 animate-in slide-in-from-right-4 duration-300">
            <div>
                <h3 className="text-base font-bold mb-6">Appearance</h3>
                <div className="space-y-6">

                    {/* Resolution */}
                    <div className="flex items-center justify-between">
                        <div>
                            <span className="text-sm font-semibold text-white block">Window Resolution</span>
                            <span className="text-xs text-[#aaaaaa]">Choose your preferred window dimensions</span>
                        </div>
                        <select
                            value={settings.resolution}
                            onChange={(e) => onUpdate({ resolution: e.target.value })}
                            className="bg-[#121212] border border-[#303030] text-sm text-white rounded-lg px-4 py-2 outline-none cursor-pointer hover:bg-[#202020] transition-colors"
                        >
                            {RESOLUTIONS.map(res => (
                                <option key={res} value={res}>{res}</option>
                            ))}
                        </select>
                    </div>

                    {/* Fullscreen */}
                    <div className="flex items-center justify-between">
                        <div>
                            <span className="text-sm font-semibold text-white block">Full Screen Mode</span>
                            <span className="text-xs text-[#aaaaaa]">Expand {BRAND.name} to fill your primary monitor</span>
                        </div>
                        <Toggle on={settings.fullscreen} onChange={() => onUpdate({ fullscreen: !settings.fullscreen })} />
                    </div>

                    {/* Video list layout */}
                    <div className="flex items-center justify-between">
                        <div>
                            <span className="text-sm font-semibold text-white block">Video List Layout</span>
                            <span className="text-xs text-[#aaaaaa]">Choose between grid and compact layout</span>
                        </div>
                        <div className={`flex gap-2 bg-[#121212] border border-[#303030] rounded-md p-0.5 ${listLocked ? 'opacity-50' : ''}`} title={listLocked ? LOCKED_TITLE : undefined}>
                            <button
                                disabled={listLocked}
                                onClick={() => onUpdate({ videoListMode: 'grid' })}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-bold transition-all cursor-pointer ${currentVideoListMode === 'grid' ? 'bg-white text-black scale-[1.02]' : 'text-[#888888] hover:text-white hover:bg-white/5'}`}
                            >
                                <LayoutGrid className="w-3.5 h-3.5" />
                                Grid
                            </button>
                            <button
                                disabled={listLocked}
                                onClick={() => onUpdate({ videoListMode: 'compact' })}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-bold transition-all cursor-pointer ${currentVideoListMode === 'compact' ? 'bg-white text-black scale-[1.02]' : 'text-[#888888] hover:text-white hover:bg-white/5'}`}
                            >
                                <List className="w-3.5 h-3.5" />
                                Compact
                            </button>
                        </div>
                    </div>

                    {/* Navigation Orientation */}
                    <div className="flex items-center justify-between">
                        <div>
                            <span className="text-sm font-semibold text-white block">Navigation Orientation</span>
                            <span className="text-xs text-[#aaaaaa]">Choose horizontal/vertical layout</span>
                        </div>
                        <div className={`flex gap-2 bg-[#121212] border border-[#303030] rounded-md p-0.5 ${navLocked ? 'opacity-50' : ''}`} title={navLocked ? LOCKED_TITLE : undefined}>
                            <button
                                disabled={navLocked}
                                onClick={() => onUpdate({ navigationOrientation: 'horizontal' })}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-bold transition-all cursor-pointer ${currentNavigationOrientation === 'horizontal' ? 'bg-white text-black scale-[1.02]' : 'text-[#888888] hover:text-white hover:bg-white/5'}`}
                            >
                                <AlignJustify className="w-3.5 h-3.5" />
                                Horizontal
                            </button>
                            <button
                                disabled={navLocked}
                                onClick={() => onUpdate({ navigationOrientation: 'vertical' })}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-bold transition-all cursor-pointer ${currentNavigationOrientation === 'vertical' ? 'bg-white text-black scale-[1.02]' : 'text-[#888888] hover:text-white hover:bg-white/5'}`}
                            >
                                <AlignLeft className="w-3.5 h-3.5" />
                                Vertical
                            </button>
                        </div>
                    </div>

                </div>
            </div>
        </div>
    );
}
