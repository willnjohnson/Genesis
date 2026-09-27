import { getWorkspaceStatus } from '../api';

/** What Ctrl+K lists first when nothing is typed: the last things opened, newest first. Kept in this machine's local
 *  storage, one list per workspace (a video or term belongs to one workspace's data). */
export type RecentKind = 'video' | 'term' | 'bio' | 'drive';

export interface Recent {
    kind: RecentKind;
    /** What opens it: a video's id, a term's name, a person's handle (without @), a Drive's storage path. */
    key: string;
    label: string;
    sub?: string;
    thumb?: string;
    /** A Drive's alias, needed to open it. */
    alias?: string | null;
}

const KEEP = 12;
let scope: Promise<string> | null = null;
// The open workspace's folder, asked for once (switching workspaces reloads the window).
const workspaceKey = () => (scope ??= getWorkspaceStatus().then(s => s.current?.folder ?? '').catch(() => ''));
const storageKey = (folder: string) => `kinesis:recents:${folder}`;

export async function loadRecents(): Promise<Recent[]> {
    try {
        const raw = localStorage.getItem(storageKey(await workspaceKey()));
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter((r): r is Recent => !!r && typeof r.key === 'string' && typeof r.label === 'string') : [];
    } catch {
        return [];
    }
}

async function save(list: Recent[]) {
    try { localStorage.setItem(storageKey(await workspaceKey()), JSON.stringify(list.slice(0, KEEP))); } catch { /* storage blocked */ }
}

/** Puts an item at the front of the list (moving it there if it was already in it). */
export async function recordRecent(item: Recent) {
    const list = await loadRecents();
    await save([item, ...list.filter(r => !(r.kind === item.kind && r.key === item.key))]);
}

export async function forgetRecent(kind: RecentKind, key: string) {
    await save((await loadRecents()).filter(r => !(r.kind === kind && r.key === key)));
}

export async function clearRecents() {
    await save([]);
}
