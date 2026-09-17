import { Star, Building2, User, Music, Trophy, Gamepad2, Mic, Dumbbell, Utensils, Newspaper, GraduationCap, Drama, Cpu, TrendingUp, BookOpen, type LucideIcon } from 'lucide-react';
import type { WdbsIconKey } from '../api';

// One entry per WDBS_ICON_KEYS value (api.ts) — keep both in sync with db::WDBS_ICONS on the Rust
// side. `label` is what WdbsIconMenu's picker shows; `Icon` is what WdbsTreePanel renders to the
// left of a node's segment name.
export const WDBS_ICON_OPTIONS: { key: WdbsIconKey; label: string; Icon: LucideIcon }[] = [
    { key: 'star', label: 'Star', Icon: Star },
    { key: 'company', label: 'Company', Icon: Building2 },
    { key: 'person', label: 'Person', Icon: User },
    { key: 'music', label: 'Music', Icon: Music },
    { key: 'sports', label: 'Sports', Icon: Trophy },
    { key: 'gaming', label: 'Gaming', Icon: Gamepad2 },
    { key: 'podcast', label: 'Podcast', Icon: Mic },
    { key: 'fitness', label: 'Fitness', Icon: Dumbbell },
    { key: 'food', label: 'Food', Icon: Utensils },
    { key: 'news', label: 'News', Icon: Newspaper },
    { key: 'education', label: 'Education', Icon: GraduationCap },
    { key: 'comedy', label: 'Comedy', Icon: Drama },
    { key: 'tech', label: 'Tech', Icon: Cpu },
    { key: 'finance', label: 'Finance', Icon: TrendingUp },
    { key: 'guides', label: 'Guides', Icon: BookOpen },
];

const ICON_BY_KEY = new Map(WDBS_ICON_OPTIONS.map(opt => [opt.key, opt.Icon]));

// `null`/unrecognized (e.g. a value from a since-removed choice) both mean "nothing to render" —
// same fallback db::wdbs.rs's get_wdbs_tree already applies server-side.
export function getWdbsIconComponent(icon: string | null | undefined): LucideIcon | undefined {
    return icon ? ICON_BY_KEY.get(icon as WdbsIconKey) : undefined;
}
