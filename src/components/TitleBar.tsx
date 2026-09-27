import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Copy, Megaphone, Minus, Square, X } from 'lucide-react';
import { getAppInfo, showSystemMenu } from '../api';
import { BRAND } from '../branding';
import { BrandLogo } from './BrandLogo';
import { UpdateButton } from './UpdateButton';
import { WhatsNewModal } from './WhatsNewModal';
import { afterDialogs } from '../lib/dialogs';
import { hasUnreadWhatsNew, markWhatsNewRead } from '../lib/whats-new';

interface Props {
    /** Back and forward through the places visited (the app's window only; the workspace screens have none). */
    history?: { back: () => void; forward: () => void; canBack: boolean; canForward: boolean };
    /** The workspace switcher, after the left buttons: only the title bar layout has it here (the others keep the workspace
     *  shortcut in the page header or the rail). It is given whether there is room to show the workspace's name in it;
     *  when not, it is just the button. */
    workspaceButton?: (showName: boolean) => ReactNode;
    /** After the arrows: the title bar layout's layout toggle and Settings. */
    leftTools?: ReactNode;
    /** The open workspace's name, shown after the left buttons while there is room for it. */
    workspaceName?: string;
    /** The title bar layout's navigation icons (Search, Library, Glossary, Biography). */
    toolbar?: ReactNode;
}

const barButton = 'flex items-center justify-center w-[22px] h-[22px] rounded text-gray-400 hover:text-white hover:bg-[#272727] transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-gray-400';
/** A thin line between groups of buttons. */
export function TitleBarDivider() {
    return <div aria-hidden className="pointer-events-none w-px h-4 bg-[#303030] mx-1.5 shrink-0" />;
}
const divider = <TitleBarDivider />;
const controlBase = 'flex items-center justify-center w-10 h-full text-gray-400 transition-colors cursor-pointer';
const controlButton = `${controlBase} hover:text-white hover:bg-[#272727]`;
// Close fills with the theme's accent instead of the gray the others use. Not built on controlButton: its hover background
// (a theme-mapped color, applied with !important in index.css) would win over the accent. Its hover text uses
// text-on-accent (always light, see lib/themes.ts), not controlButton's hover:text-white — that one tracks the
// theme's regular text color, which flips dark on a light theme and would read muted/wrong against the accent fill.
const closeButton = `${controlBase} hover:text-[var(--k-text-on-accent)] hover:bg-[var(--k-accent)]`;

/**
 * The window's own title bar (the window has no native one). Slim, and draggable: from left, the back and forward
 * arrows (Alt + Left / Alt + Right), the title bar layout's workspace button, the logo and name; from right, the
 * window controls (minimize, maximize or restore, close), What's New, and beside it the room for the update button
 * (UpdateButton, still empty), with the title bar layout's navigation icons before those.
 *
 * Dragging and double-clicking to maximize come from `data-tauri-drag-region`: it works on the element that carries
 * it, so everything that isn't a button either has it or ignores the pointer.
 */
export function TitleBar({ history, workspaceButton, leftTools, workspaceName, toolbar }: Props) {
    const [maximized, setMaximized] = useState(false);
    const [showWhatsNew, setShowWhatsNew] = useState(false);
    // A dot beside the megaphone while the current notes haven't been opened.
    const [unread, setUnread] = useState(hasUnreadWhatsNew);
    // The window menu a native title bar shows on a right-click. The frameless window has none: on Windows the real system
    // menu is asked for (src-tauri/src/commands/window_menu.rs); elsewhere this draws a smaller one where the click was.
    const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    // The app's version, shown after its name.
    const [version, setVersion] = useState('');
    useEffect(() => { getAppInfo().then(info => setVersion(info.version)).catch(() => {}); }, []);

    // The workspace's name sits after the left buttons and gives way when the window is scrunched. It is kept only
    // while the title could still sit at the window's exact center: the room each side has left, beside its buttons
    // (and the name), must hold half of it. The name is measured off screen, since when it is hidden it can't be.
    const barRef = useRef<HTMLDivElement>(null);
    const leftRef = useRef<HTMLDivElement>(null);
    const rightRef = useRef<HTMLDivElement>(null);
    const titleRef = useRef<HTMLSpanElement>(null);
    const nameRef = useRef<HTMLSpanElement>(null);
    const [showWorkspace, setShowWorkspace] = useState(true);
    const hasSwitcher = !!workspaceButton;
    const title = `${BRAND.name}${version ? ` v${version}` : ''}`;
    useLayoutEffect(() => {
        const bar = barRef.current;
        if (!bar) return;
        const measure = () => {
            // The left buttons, then the name with the title bar layout's switcher: it is the bare 22px button (and its 2px
            // margin) plus the name and 8 more. Nothing here is read from what is currently shown, so showing or hiding
            // the name can't change the answer (which would flip it back and forth).
            const nameExtra = workspaceName ? (nameRef.current?.offsetWidth ?? 0) + 8 : 0;
            const left = (leftRef.current?.offsetWidth ?? 0) + (hasSwitcher ? 24 : 0) + nameExtra;
            const right = rightRef.current?.offsetWidth ?? 0;
            const sides = Math.max(left, right);
            // The logo (14) and its gap (8), the padding around the title (24), and a little air on each side (12).
            const base = (titleRef.current?.offsetWidth ?? 0) + 14 + 8 + 24;
            if (workspaceName) setShowWorkspace(bar.clientWidth >= base + 2 * (sides + 12));
        };
        measure();
        const observer = new ResizeObserver(measure);
        [bar, leftRef.current, rightRef.current, titleRef.current, nameRef.current].forEach(el => el && observer.observe(el));
        return () => observer.disconnect();
    }, [workspaceName, version, hasSwitcher]);

    useEffect(() => {
        let stop: (() => void) | undefined;
        try {
            const appWindow = getCurrentWindow();
            const sync = () => { appWindow.isMaximized().then(setMaximized).catch(() => {}); };
            sync();
            appWindow.onResized(sync).then(unlisten => { stop = unlisten; }).catch(() => {});
        } catch { /* not in the app window (a plain browser) */ }
        return () => stop?.();
    }, []);

    // Dimmed while the window isn't the one with focus (clicked off to another app, say), the way a native title bar
    // goes muted: it's still all there and usable, just less insistent about it.
    const [focused, setFocused] = useState(true);
    useEffect(() => {
        let stop: (() => void) | undefined;
        try {
            const appWindow = getCurrentWindow();
            appWindow.isFocused().then(setFocused).catch(() => {});
            appWindow.onFocusChanged(({ payload }) => setFocused(payload)).then(unlisten => { stop = unlisten; }).catch(() => {});
        } catch { /* not in the app window (a plain browser) */ }
        return () => stop?.();
    }, []);
    // Applied to most of the bar's content while unfocused (not the window controls: they get their own opacity below, on
    // the same element as their hover styles, since a parent's opacity can't be undone by a hovered child's).
    const dim = `transition-opacity duration-200 ${focused ? '' : 'opacity-60'}`;

    useEffect(() => {
        if (!menuAt) return;
        const close = () => setMenuAt(null);
        const away = (e: globalThis.MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) close(); };
        const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
        document.addEventListener('mousedown', away);
        document.addEventListener('keydown', escape);
        window.addEventListener('blur', close);
        window.addEventListener('resize', close);
        return () => {
            document.removeEventListener('mousedown', away);
            document.removeEventListener('keydown', escape);
            window.removeEventListener('blur', close);
            window.removeEventListener('resize', close);
        };
    }, [menuAt]);

    // Right-clicking the bar itself (not its buttons, and not the logo, which has its own menu).
    const openWindowMenu = (e: MouseEvent) => {
        if ((e.target as Element).closest('button')) return;
        e.preventDefault();
        const at = { x: e.clientX, y: e.clientY };
        showSystemMenu().then(shown => { if (!shown) setMenuAt(at); }).catch(() => setMenuAt(at));
    };

    const windowAction = (run: (w: ReturnType<typeof getCurrentWindow>) => Promise<void>) => () => {
        try { void run(getCurrentWindow()); } catch { /* not in the app window */ }
    };

    return (
        // Three columns: the two outer ones share the leftover width equally, so the title in the middle sits exactly
        // at the window's center while both sides fit. When a side needs more room than its share (a narrow window),
        // its column grows and the title slides toward the other side instead of disappearing or overlapping.
        <div
            ref={barRef}
            data-app-titlebar
            data-tauri-drag-region
            onContextMenu={openWindowMenu}
            // Above the dimming layers of dialogs and the sidebar, so the window can still be moved and closed.
            className="relative z-[300] shrink-0 grid grid-cols-[1fr_auto_1fr] items-stretch h-[var(--k-titlebar-height)] bg-[#0f0f0f] border-b border-[#272727] select-none"
        >
            <div data-tauri-drag-region className={`flex items-center pl-2 min-w-0 ${dim}`}>
              <div ref={leftRef} className="flex items-center w-max">
                {history && (
                    <div className="flex items-center gap-1">
                        <button onClick={history.back} disabled={!history.canBack} className={barButton} title="Back (Alt + Left)" aria-label="Back">
                            <ArrowLeft className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={history.forward} disabled={!history.canForward} className={barButton} title="Forward (Alt + Right)" aria-label="Forward">
                            <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                    </div>
                )}
                {leftTools && (
                    <>
                        {history && divider}
                        <div className="flex items-center gap-0.5">{leftTools}</div>
                    </>
                )}
              </div>
              {/* After the last left button. Without the title bar layout's switcher, the name is plain text that ignores the
                  pointer, so a press on it drags the window. */}
              {!workspaceButton && workspaceName && showWorkspace && (
                  <span data-workspace-name className="pointer-events-none ml-2 whitespace-nowrap text-[13px] text-gray-400 leading-none">{workspaceName}</span>
              )}
              {/* The workspace switcher, name and button as one; the name gives way, the button stays. */}
              {workspaceButton && <span data-workspace-switch className="flex items-center ml-0.5">{workspaceButton(!!workspaceName && showWorkspace)}</span>}
            </div>

            <div data-tauri-drag-region className={`flex items-center justify-center px-3 ${dim}`}>
                {/* The logo beside the title, in every layout (including the ones that keep the logo and name in the page
                    header): the pair sits at the window's center. */}
                <div data-tauri-drag-region className="flex items-center gap-2">
                    <BrandLogo className="w-3.5 h-3.5" dragRegion />
                    {/* The text ignores the pointer so a press on it lands on the parent, which is what makes it drag the window. */}
                    <div data-tauri-drag-region className="flex items-center">
                        <span className="pointer-events-none whitespace-nowrap text-[13px] text-gray-400 leading-none">{title}</span>
                    </div>
                </div>
            </div>

            <div data-tauri-drag-region className="flex items-stretch justify-end min-w-0">
              <div ref={rightRef} className="flex items-stretch w-max">
                {toolbar && <div className={`flex items-center ${dim}`}>{toolbar}{divider}</div>}
                {/* Updates and announcements, together. */}
                <div className={`flex items-center gap-0.5 pr-1 ${dim}`}>
                    <UpdateButton />
                    <button
                        onClick={showWhatsNew ? () => setShowWhatsNew(false) : afterDialogs(() => { setShowWhatsNew(true); markWhatsNewRead(); setUnread(false); })}
                        className={unread ? barButton.replace('w-[22px]', 'min-w-[22px] px-1.5 gap-1.5') : barButton}
                        title={unread ? "What's New (unread)" : "What's New"}
                        aria-label={unread ? "What's New, unread" : "What's New"}
                    >
                        {unread && <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-[var(--k-accent)] shrink-0" />}
                        <Megaphone className="w-3.5 h-3.5" />
                    </button>
                </div>
                {/* Not wrapped in the dim above (an ancestor's opacity can't be undone by a hovered child's): minimize and
                    maximize/restore just get it directly, dimming on hover too, like the rest of the bar. Close gets its
                    own copy plus hover:opacity-100, so it alone brightens back up when hovered. */}
                <div className="flex items-stretch">
                    <button data-k-cmd="minimize" onClick={windowAction(w => w.minimize())} className={`${controlButton} ${dim}`} title="Minimize" aria-label="Minimize">
                        <Minus className="w-3.5 h-3.5" />
                    </button>
                    <button data-k-cmd="toggle_maximize" onClick={windowAction(w => w.toggleMaximize())} className={`${controlButton} ${dim}`} title={maximized ? 'Restore' : 'Maximize'} aria-label={maximized ? 'Restore' : 'Maximize'}>
                        {maximized ? <Copy className="w-3 h-3" /> : <Square className="w-3 h-3" />}
                    </button>
                    <button data-k-cmd="close" onClick={windowAction(w => w.close())} className={`${closeButton} ${dim} hover:opacity-100`} title="Close" aria-label="Close">
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
              </div>
            </div>

            {/* Off screen: the title's and the name's widths, for the fit check above. */}
            <span aria-hidden className="pointer-events-none invisible absolute top-0 left-0 whitespace-nowrap text-[13px] leading-none">
                <span ref={titleRef} className="inline-block">{title}</span>
                {workspaceName && <span ref={nameRef} className="inline-block">{workspaceName}</span>}
            </span>

            {menuAt && createPortal(
                <div
                    ref={menuRef}
                    role="menu"
                    // Above the title bar (z-300); kept inside the window.
                    style={{ left: Math.min(menuAt.x, window.innerWidth - 200), top: Math.min(menuAt.y, window.innerHeight - 140) }}
                    className="fixed w-48 bg-[#272727] border border-[#3f3f3f] rounded-lg shadow-xl z-[320] overflow-hidden py-1 select-none"
                >
                    {([
                        { label: 'Restore', icon: Copy, disabled: !maximized, run: (w: ReturnType<typeof getCurrentWindow>) => w.unmaximize() },
                        { label: 'Minimize', icon: Minus, run: (w: ReturnType<typeof getCurrentWindow>) => w.minimize() },
                        { label: 'Maximize', icon: Square, disabled: maximized, run: (w: ReturnType<typeof getCurrentWindow>) => w.maximize() },
                        { label: 'Close', icon: X, hint: /Mac/.test(navigator.platform) ? undefined : 'Alt+F4', divider: true, run: (w: ReturnType<typeof getCurrentWindow>) => w.close() },
                    ]).map(item => (
                        <button
                            key={item.label}
                            role="menuitem"
                            disabled={item.disabled}
                            onClick={() => { setMenuAt(null); windowAction(item.run)(); }}
                            className={`w-full text-left px-3 py-1.5 flex items-center gap-2.5 text-sm text-gray-300 hover:bg-[#3f3f3f] disabled:text-gray-600 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default ${item.divider ? 'border-t border-[#3f3f3f] mt-1 pt-2' : ''}`}
                        >
                            <item.icon className="w-3.5 h-3.5 shrink-0" />
                            <span className="flex-1">{item.label}</span>
                            {item.hint && <span className="text-[11px] text-gray-500">{item.hint}</span>}
                        </button>
                    ))}
                </div>,
                document.body,
            )}

            {showWhatsNew && <WhatsNewModal onClose={() => setShowWhatsNew(false)} />}
        </div>
    );
}
