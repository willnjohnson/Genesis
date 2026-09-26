/**
 * What a piece of pasted text is, as far as saving a video goes. The tray's quick-save popup reads the clipboard
 * and needs to tell a video link from a playlist or channel link (which Search handles, not a one-click save).
 */

// watch?v=ID (the v parameter anywhere in the query), youtu.be/ID, and the /shorts/, /embed/, /live/ and /v/ forms.
// Covers www., m., and music. hosts, since they all contain "youtube.com/".
const VIDEO_URL = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/i;

/** The video ID in a YouTube link, or in text that is just an ID; null when it isn't a video. */
export function extractYouTubeVideoId(text: string): string | null {
    const trimmed = text.trim();
    const fromUrl = trimmed.match(VIDEO_URL);
    if (fromUrl) return fromUrl[1];
    return /^[A-Za-z0-9_-]{11}$/.test(trimmed) ? trimmed : null;
}

/** A YouTube link that is a channel, handle or playlist (no single video to save). */
export function isYouTubeListLink(text: string): boolean {
    const t = text.trim();
    if (extractYouTubeVideoId(t) && VIDEO_URL.test(t)) return false;
    return /youtube\.com\/(?:playlist\?|@|channel\/|c\/|user\/)/i.test(t);
}
