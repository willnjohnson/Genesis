// The size and shape of an action button in Settings, so every tab's buttons match. The reference is
// the API Key tab's Submit / Deactivate: 11px text, 16px by 8px padding, rounded corners. Primary is
// the accent color (the one thing to do), secondary is the quiet grey. Add layout (w-full, flex-1) around
// these, not new sizes.
const base = "px-4 py-2 rounded-lg text-[11px] flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default";

export const settingsPrimaryBtn = `${base} bg-red-600 text-white hover:bg-red-500 font-bold`;
export const settingsSecondaryBtn = `${base} bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] disabled:hover:bg-[#222222] text-white font-semibold`;
