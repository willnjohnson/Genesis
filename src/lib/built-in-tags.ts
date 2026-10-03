import { Clock, Flag, History, KeyRound, Star, type LucideIcon } from 'lucide-react';
import { BUILT_IN_TAGS, foldName } from './glossary';

/** Each built-in tag's icon (lib/glossary.ts's BUILT_IN_TAGS), shown in place of a bullet wherever they're listed: the
 *  Glossary's "Essentials" section and the video sidebar's tag dropdown. */
const ICONS: Record<string, LucideIcon> = {
    [foldName('Watch Later')]: Clock,
    [foldName('Favorite')]: Star,
    [foldName('Revisit')]: History,
    [foldName('Key Source')]: KeyRound,
    [foldName('Follow Up')]: Flag,
};

/** The icon of the built-in tag called `name` (any case), or undefined for any other name. */
export function builtInTagIcon(name: string): LucideIcon | undefined {
    return ICONS[foldName(name.trim())];
}

/** Where a built-in tag sits in BUILT_IN_TAGS' order, or -1 for any other name: to list them in that order, not A-Z. */
export function builtInTagRank(name: string): number {
    return BUILT_IN_TAGS.findIndex(t => foldName(t) === foldName(name.trim()));
}
