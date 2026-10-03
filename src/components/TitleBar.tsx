import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Copy, Megaphone, Minus, Square, X } from 'lucide-react';
import { getAppInfo, showSystemMenu } from '../api';
import { BRAND } from '../branding';
import { BrandLogo } from './BrandLogo';
import { UpdateButton } from './UpdateButton';
import { WhatsNewModal } from './WhatsNewModal';
import { useHasOpenDialog } from '../lib/dialogs';
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
    /** Before What's New on the right: the title bar layout's layout toggle and Settings. */
    toolbar?: ReactNode;
    /** The title bar layout's sections (Search, Library, Glossary, Biography), as binder tabs after the workspace. With
     *  them, the bar runs left to right (arrows, logo and name, workspace, tabs) instead of centering the title. */
    tabs?: TitleBarTab[];
}

export interface TitleBarTab {
    key: string;
    label: string;
    icon: ReactNode;
    active: boolean;
    onClick: () => void;
}

/** How much the tabbed bar has given up to fit: the tabs' names first, then the workspace's, then the app's. */
type Squeeze = 0 | 1 | 2 | 3;

/** A loss of focus this soon after the bar is pressed is the window manager taking the pointer to move the window (Linux). */
const MOVE_GRAB_MS = 400;
/** Page mouse events this soon after that loss of focus are the grab starting, not the move ending. */
const SETTLE_MS = 250;

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

/** One binder tab. Bottom-aligned with a rounded top; the open one is the page's own color, covers the bar's bottom line
 *  (it's drawn above it, see TitleBar) and carries an accent strip along its bottom. */
function BinderTab({ tab, compact, locked = false }: { tab: TitleBarTab; compact: boolean; locked?: boolean }) {
    return (
        <button
            onClick={tab.onClick}
            disabled={locked}
            title={locked ? `${tab.label} (close the open window first)` : tab.label}
            aria-label={tab.label}
            aria-current={tab.active ? 'page' : undefined}
            className={`relative flex items-center justify-center gap-1 shrink-0 rounded-t-md border border-b-0 text-[11px] leading-none whitespace-nowrap transition-colors cursor-pointer disabled:cursor-default ${compact ? 'w-8' : 'px-2.5'} ${tab.active
                ? 'z-10 h-[calc(100%-4px)] bg-[#0f0f0f] border-[#404040] text-white font-semibold shadow-[inset_0_-2px_0_var(--k-accent)]'
                : 'h-[calc(100%-5px)] mb-px bg-[#1a1a1a] border-[#303030] text-gray-400 hover:text-white hover:bg-[#272727] disabled:opacity-40 disabled:hover:text-gray-400 disabled:hover:bg-[#1a1a1a]'}`}
        >
            {tab.icon}
            {!compact && <span>{tab.label}</span>}
        </button>
    );
}

/**
 * The window's own title bar (the window has no native one). Slim, and draggable: from left, the back and forward
 * arrows (Alt + Left / Alt + Right), the title bar layout's workspace button, the logo and name; from right, the
 * window controls (minimize, maximize or restore, close), What's New, and beside it the room for the update button
 * (UpdateButton, still empty), with the title bar layout's navigation icons before those.
 *
 * Dragging and double-clicking to maximize come from `data-tauri-drag-region`: it works on the element that carries
 * it, so everything that isn't a button either has it or ignores the pointer.
 */
export function TitleBar({ history, workspaceButton, leftTools, workspaceName, toolbar, tabs }: Props) {
    const [maximized, setMaximized] = useState(false);
    const [showWhatsNew, setShowWhatsNew] = useState(false);
    // The bar sits above the dialogs so the window can still be moved, minimized and closed, not so the page under an
    // open one can be changed or another opened over it: while one is open, Back/Forward, the tabs, the layout toggle,
    // Settings and What's New wait, as they do in the other layouts, where the dialog covers them. The window controls don't.
    const locked = useHasOpenDialog();
    const lockedTitle = (title: string) => (locked ? `${title} (close the open window first)` : title);
    // A dot beside the megaphone while the current notes haven't been opened.
    const [unread, setUnread] = useState(hasUnreadWhatsNew);
    // The window menu a native title bar shows on a right-click. The frameless window has none: on Windows and Linux the
    // system's own is asked for (src-tauri/src/commands/window_menu.rs); elsewhere this draws a smaller one where the click was.
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
        if (!bar || tabs) return;
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
    }, [workspaceName, version, hasSwitcher, !!tabs]);

    // The tabbed bar gives way in steps (see Squeeze), each taken only once everything before it no longer fits. Every
    // width comes from what never changes with the step (the left buttons, the right side, and off-screen copies of the
    // title, the name and both forms of the tabs), so taking a step can't change the answer and flip it back.
    const tabsFullRef = useRef<HTMLDivElement>(null);
    const tabsIconRef = useRef<HTMLDivElement>(null);
    const [squeeze, setSqueeze] = useState<Squeeze>(0);
    const tabKeys = tabs?.map(t => `${t.key}:${t.label}`).join('|') ?? '';
    useLayoutEffect(() => {
        const bar = barRef.current;
        if (!bar || !tabs) return;
        const measure = () => {
            const w = (el: HTMLElement | null) => el?.offsetWidth ?? 0;
            // The bar's own left padding (8), the three gaps between groups (12 each), the logo (14) and a little air (16).
            const base = 8 + 36 + 14 + 16 + w(leftRef.current) + w(rightRef.current);
            const title = 8 + w(titleRef.current);
            // The switcher: the bare 22px button, or the name in it (8 left, 4 gap, 14 chevrons, 4 right).
            const named = workspaceName ? w(nameRef.current) + 30 : 22;
            const fits = (step: Squeeze) =>
                base + (step < 3 ? title : 0) + (step < 2 ? named : 22) + (step < 1 ? w(tabsFullRef.current) : w(tabsIconRef.current)) <= bar.clientWidth;
            setSqueeze(fits(0) ? 0 : fits(1) ? 1 : fits(2) ? 2 : 3);
        };
        measure();
        const observer = new ResizeObserver(measure);
        [bar, leftRef.current, rightRef.current, titleRef.current, nameRef.current, tabsFullRef.current, tabsIconRef.current].forEach(el => el && observer.observe(el));
        return () => observer.disconnect();
    }, [workspaceName, version, tabKeys]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Moving the window by the bar doesn't count: on Linux the window manager takes the pointer and keyboard for the
    // move, and the window is told it lost focus though it's still the one in front. So a loss of focus that comes just
    // after the bar was pressed is set aside as that move, and the window is asked again once the move is over.
    // Timed, not tracked by the page's own mouse events: when the window manager takes the pointer, WebKitGTK can hand
    // the page a stray mouseup/mousemove right then, which made the move look over (and the window unfocused) at once.
    const [focused, setFocused] = useState(true);
    const barPressedAt = useRef(-Infinity);
    useEffect(() => {
        let stop: (() => void) | undefined;
        let recheck: ((e: Event) => void) | undefined;
        const stopRecheck = () => {
            if (!recheck) return;
            document.removeEventListener('mousemove', recheck);
            document.removeEventListener('mouseup', recheck);
            recheck = undefined;
        };
        try {
            const appWindow = getCurrentWindow();
            appWindow.isFocused().then(setFocused).catch(() => {});
            appWindow.onFocusChanged(({ payload }) => {
                stopRecheck();
                if (payload || performance.now() - barPressedAt.current > MOVE_GRAB_MS) {
                    setFocused(payload);
                    return;
                }
                // The move's grab. The pointer only comes back to the page once the move is over; anything the page
                // gets before SETTLE_MS is the stray event from the grab starting, so it's ignored.
                const lostAt = performance.now();
                recheck = () => {
                    if (performance.now() - lostAt < SETTLE_MS) return;
                    stopRecheck();
                    appWindow.isFocused().then(setFocused).catch(() => {});
                };
                document.addEventListener('mousemove', recheck);
                document.addEventListener('mouseup', recheck);
            }).then(unlisten => { stop = unlisten; }).catch(() => {});
        } catch { /* not in the app window (a plain browser) */ }
        return () => {
            stop?.();
            stopRecheck();
        };
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

    const backForward = history && (
        <div className="flex items-center gap-1">
            <button onClick={history.back} disabled={!history.canBack || locked} className={barButton} title={lockedTitle('Back (Alt + Left)')} aria-label="Back">
                <ArrowLeft className="w-3.5 h-3.5" />
            </button>
            <button onClick={history.forward} disabled={!history.canForward || locked} className={barButton} title={lockedTitle('Forward (Alt + Right)')} aria-label="Forward">
                <ArrowRight className="w-3.5 h-3.5" />
            </button>
        </div>
    );
    const brand = (showTitle: boolean) => (
        <div data-tauri-drag-region className="flex items-center gap-2">
            <BrandLogo className="w-3.5 h-3.5" dragRegion />
            {/* The text ignores the pointer so a press on it lands on the parent, which is what makes it drag the window. */}
            {showTitle && (
                <div data-tauri-drag-region className="flex items-center">
                    <span className="pointer-events-none whitespace-nowrap text-[13px] text-gray-400 leading-none">{title}</span>
                </div>
            )}
        </div>
    );

    return (
        // Without tabs, three columns: the two outer ones share the leftover width equally, so the title in the middle
        // sits exactly at the window's center while both sides fit. When a side needs more room than its share (a narrow
        // window), its column grows and the title slides toward the other side instead of disappearing or overlapping.
        // With tabs (the title bar layout), one row from the left, and the right side after the room that's left.
        <div
            ref={barRef}
            data-app-titlebar
            data-tauri-drag-region
            onContextMenu={openWindowMenu}
            onMouseDown={e => {
                if (e.button !== 0 || (e.target as Element).closest('button')) return;
                barPressedAt.current = performance.now();
            }}
            // Above the dimming layers of dialogs and the sidebar, so the window can still be moved and closed.
            className={`relative z-[300] shrink-0 items-stretch h-[var(--k-titlebar-height)] bg-[#0f0f0f] select-none ${tabs ? 'flex' : 'grid grid-cols-[1fr_auto_1fr] border-b border-[#272727]'}`}
        >
          {tabs ? (
            <>
                {/* The bar's bottom line. Drawn rather than a border, so the open tab (above it) can cover it. */}
                <div aria-hidden className="pointer-events-none absolute left-0 right-0 bottom-0 h-px bg-[#272727]" />
                <div data-tauri-drag-region className={`flex items-center pl-2 shrink-0 ${dim}`}>
                    <div ref={leftRef} className="flex items-center w-max">{backForward}</div>
                </div>
                <div data-tauri-drag-region className={`flex items-center ml-3 shrink-0 ${dim}`}>{brand(squeeze < 3)}</div>
                {workspaceButton && <span data-workspace-switch className={`flex items-center ml-3 shrink-0 ${dim}`}>{workspaceButton(!!workspaceName && squeeze < 2)}</span>}
                {/* The tabs, then the rest of the row, which still drags the window. Above the bottom line (z-10), so
                    the open tab covers it; the others stop a pixel short and leave it showing under them. */}
                <nav data-tauri-drag-region aria-label="Sections" className={`relative z-10 flex items-end gap-0.5 ml-3 flex-1 min-w-0 overflow-hidden ${dim}`}>
                    {tabs.map(tab => <BinderTab key={tab.key} tab={tab} compact={squeeze >= 1} locked={locked} />)}
                </nav>
            </>
          ) : (
            <>
            <div data-tauri-drag-region className={`flex items-center pl-2 min-w-0 ${dim}`}>
              <div ref={leftRef} className="flex items-center w-max">
                {backForward}
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
                {brand(true)}
            </div>
            </>
          )}

            <div data-tauri-drag-region className={`flex items-stretch justify-end min-w-0 ${tabs ? 'shrink-0' : ''}`}>
              <div ref={rightRef} className="flex items-stretch w-max">
                {toolbar && (
                    <div className={`flex items-center ${dim}`} title={locked ? 'Close the open window first' : undefined}>
                        {/* Its buttons are App's: while locked they're greyed and made inert as a group (no pointer, no focus). */}
                        <div className={`flex items-center transition-opacity ${locked ? 'opacity-40' : ''}`} inert={locked}>{toolbar}</div>
                        {divider}
                    </div>
                )}
                {/* Updates and announcements, together. */}
                <div className={`flex items-center gap-0.5 pr-1 ${dim}`}>
                    <UpdateButton />
                    <button
                        // Waits while another window is open, like the rest; with its own notes open, it still closes them.
                        onClick={showWhatsNew ? () => setShowWhatsNew(false) : () => { setShowWhatsNew(true); markWhatsNewRead(); setUnread(false); }}
                        disabled={locked && !showWhatsNew}
                        className={unread ? barButton.replace('w-[22px]', 'min-w-[22px] px-1.5 gap-1.5') : barButton}
                        title={showWhatsNew ? "What's New" : lockedTitle(unread ? "What's New (unread)" : "What's New")}
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

            {/* Off screen: the title's and the name's widths (and the tabs', both ways), for the fit checks above. */}
            <span aria-hidden className="pointer-events-none invisible absolute top-0 left-0 whitespace-nowrap text-[13px] leading-none">
                <span ref={titleRef} className="inline-block">{title}</span>
                {workspaceName && <span ref={nameRef} className="inline-block">{workspaceName}</span>}
            </span>
            {tabs && (
                <div aria-hidden className="pointer-events-none invisible absolute top-0 left-0 h-full">
                    <div ref={tabsFullRef} className="absolute top-0 left-0 h-full flex items-end gap-0.5 w-max">
                        {tabs.map(tab => <BinderTab key={tab.key} tab={tab} compact={false} />)}
                    </div>
                    <div ref={tabsIconRef} className="absolute top-0 left-0 h-full flex items-end gap-0.5 w-max">
                        {tabs.map(tab => <BinderTab key={tab.key} tab={tab} compact />)}
                    </div>
                </div>
            )}

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
