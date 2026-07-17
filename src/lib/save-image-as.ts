import { save } from '@tauri-apps/plugin-dialog';
import { fetchImageAsDataUri, saveImage } from '../api';

interface SaveImageAsOptions {
    filters: { name: string; extensions: string[] }[];
    defaultPath: string;
}

/**
 * Fetches `url` as a data URI (if it isn't one already), prompts a native save-file dialog,
 * and writes the decoded bytes to the chosen path. Errors are logged, not thrown or surfaced
 * to the caller, since none of the call sites need to react beyond a console log.
 */
export async function saveImageAs(url: string, options: SaveImageAsOptions): Promise<void> {
    try {
        let dataUri = url;
        if (!url.startsWith('data:')) {
            dataUri = await fetchImageAsDataUri(url);
        }
        if (!dataUri) return;

        const filePath = await save({
            filters: options.filters,
            defaultPath: options.defaultPath,
        });

        if (filePath) {
            const parts = dataUri.split(',');
            const base64 = parts.length > 1 ? parts[1] : parts[0];
            await saveImage(filePath, base64);
        }
    } catch (e: any) {
        console.error("Save failed:", e);
    }
}
