import { useCallback, useEffect, useState } from 'react';
import { trashList, TRASH_CHANGED_EVENT, type TrashEntry, type TrashKind } from '../api';

/** What's in the Trash for one kind of item, kept current: it reloads whenever anything in the app changes the
 *  Trash (a delete, a restore, an emptying). */
export function useTrash(kind: TrashKind) {
    const [entries, setEntries] = useState<TrashEntry[]>([]);

    const refresh = useCallback(() => {
        trashList(kind).then(setEntries).catch(() => setEntries([]));
    }, [kind]);

    useEffect(() => {
        refresh();
        window.addEventListener(TRASH_CHANGED_EVENT, refresh);
        return () => window.removeEventListener(TRASH_CHANGED_EVENT, refresh);
    }, [refresh]);

    return { entries, count: entries.length, refresh };
}
