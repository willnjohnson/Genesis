import { useEffect, useState, type CSSProperties } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Only Linux needs these: Windows and macOS show the resize cursors of a frameless window on their own.
const isLinux = typeof navigator !== 'undefined' && /Linux/i.test(navigator.platform) && !/Android/i.test(navigator.userAgent);

/**
 * The resize cursors at the window's edges and corners on Linux. The frameless window can still be resized there
 * (tao catches the press on the GTK window underneath and starts the resize), and tao sets the matching cursor too,
 * but on the GTK window, which the webview covers entirely: WebKit's own cursor, from the page's CSS, is the one
 * shown. So the page draws invisible strips over the same band tao resizes from, carrying the cursors itself.
 * They only give the cursor; the press still passes through to tao. Gone while maximized or fullscreen, where tao
 * doesn't resize either.
 */
export function ResizeEdges() {
    const [resizable, setResizable] = useState(isLinux);
    useEffect(() => {
        if (!isLinux) return;
        let stop: (() => void) | undefined;
        try {
            const appWindow = getCurrentWindow();
            const sync = () => {
                Promise.all([appWindow.isMaximized(), appWindow.isFullscreen()])
                    .then(([maximized, fullscreen]) => setResizable(!maximized && !fullscreen))
                    .catch(() => {});
            };
            sync();
            appWindow.onResized(sync).then(unlisten => { stop = unlisten; }).catch(() => {});
        } catch {
            setResizable(false); // Not in the app window (a plain browser).
        }
        return () => stop?.();
    }, []);
    if (!resizable) return null;

    // tao's band: 5px times GDK's scale factor, which is a whole number and what WebKit reports as the pixel ratio.
    const b = 5 * Math.max(1, Math.round(window.devicePixelRatio || 1));
    const edge = (style: CSSProperties, cursor: string) => (
        <div aria-hidden style={{ position: 'fixed', zIndex: 2147483647, cursor, ...style }} />
    );
    return (
        <>
            {edge({ top: 0, left: b, right: b, height: b }, 'n-resize')}
            {edge({ bottom: 0, left: b, right: b, height: b }, 's-resize')}
            {edge({ left: 0, top: b, bottom: b, width: b }, 'w-resize')}
            {edge({ right: 0, top: b, bottom: b, width: b }, 'e-resize')}
            {edge({ top: 0, left: 0, width: b, height: b }, 'nw-resize')}
            {edge({ top: 0, right: 0, width: b, height: b }, 'ne-resize')}
            {edge({ bottom: 0, left: 0, width: b, height: b }, 'sw-resize')}
            {edge({ bottom: 0, right: 0, width: b, height: b }, 'se-resize')}
        </>
    );
}
