import { useEffect, useRef } from "react";
import { advance, newBoard, paintLine, randomPattern, stamp, type Board } from "../../lib/life";

// ↑↑↓↓←→←→BA. Letters are matched case-insensitively so Caps Lock doesn't break the streak.
const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];

/**
 * An endless Conway's Game of Life, drawn faintly behind the Workspaces screen.
 *
 * The board wraps around at its edges, so gliders that leave one side come back on the other. Life
 * left alone always ends up as still lifes and blinkers, so the board watches for that (its state
 * repeating, or nearly everything dying) and drops in a fresh patch of random cells, which keeps it
 * going forever without ever restarting from scratch. Cells fade in and out instead of popping, and a
 * newly born cell glows in the theme's accent color for a moment.
 *
 * It can be played with. Click the empty background (not a card or a button) and a random famous
 * pattern lands there: a glider or a spaceship that sets off across the board, or a tiny R-pentomino or
 * acorn that erupts into thousands of generations of chaos. Click and drag to draw living cells that
 * then behave like any others. The cell under the pointer lights up in the accent color so you can see
 * where a click will land. Only elements marked `data-life-surface` count as background.
 *
 * Colors come from the active theme (its text color and accent), at low opacity, so it reads as
 * texture and never competes with what's on the screen. For people who ask their system for reduced
 * motion it draws one still frame, doesn't animate and doesn't react to the pointer.
 *
 * The Konami code (↑↑↓↓←→←→BA) swaps every square cell for a circle (and back again, entered a
 * second time) — a change to the whole board at once rather than something added to it, so it
 * reads immediately instead of needing to be picked out among everything already moving.
 */

const CELL = 12; // css pixels per cell, including its gap
const GAP = 2;
const STEP_MS = 150; // one generation
const MAX_ALPHA = 0.08; // how strong a fully alive cell is
const GLOW_ALPHA = 0.26; // how strong a newborn's accent glow is

function themeColor(name: string, fallback: string): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

export function LifeBackground() {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const holder = canvas?.parentElement;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !holder || !ctx) return;

        const still = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        let board: Board | null = null;
        let fg = "#ffffff";
        let accent = "#dc2626";
        let raf = 0;
        let last = 0;
        let acc = 0;
        // The pointer: the cell it's over, and a press that turns into a click (drops a pattern) or a
        // drag (draws cells) depending on whether it moves.
        let hover: { x: number; y: number } | null = null;
        let pressed = false;
        let dragged = false;
        let downCell = { x: 0, y: 0 };
        let lastCell = { x: 0, y: 0 };
        // Cells are circles, like the loading animation's. The Konami code toggles this (to squares, from here). Read
        // by fillCell below; nothing else about the simulation or the interaction changes, just how a filled-in cell is drawn.
        let circles = true;

        const fillCell = (x: number, y: number, size: number) => {
            if (circles) {
                ctx.beginPath();
                ctx.arc(x * CELL + size / 2, y * CELL + size / 2, size / 2, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.fillRect(x * CELL, y * CELL, size, size);
            }
        };

        const draw = (dt: number) => {
            const b = board;
            if (!b) return;
            const w = b.cols * CELL;
            const h = b.rows * CELL;
            ctx.clearRect(0, 0, w, h);
            const rise = 1 - Math.exp(-dt / 90);
            const fall = 1 - Math.exp(-dt / 320);
            const fade = Math.exp(-dt / 240);
            const size = CELL - GAP;
            for (let y = 0; y < b.rows; y++) {
                for (let x = 0; x < b.cols; x++) {
                    const i = y * b.cols + x;
                    const target = b.alive[i];
                    b.shade[i] += (target - b.shade[i]) * (target ? rise : fall);
                    b.glow[i] *= fade;
                    const s = b.shade[i];
                    if (s < 0.03 && b.glow[i] < 0.05) continue;
                    if (s >= 0.03) {
                        ctx.globalAlpha = s * MAX_ALPHA;
                        ctx.fillStyle = fg;
                        fillCell(x, y, size);
                    }
                    if (b.glow[i] >= 0.05) {
                        ctx.globalAlpha = b.glow[i] * GLOW_ALPHA;
                        ctx.fillStyle = accent;
                        fillCell(x, y, size);
                    }
                }
            }
            // Where a click would land.
            if (hover && hover.x < b.cols && hover.y < b.rows) {
                ctx.globalAlpha = 0.16;
                ctx.fillStyle = accent;
                fillCell(hover.x, hover.y, size);
            }
            ctx.globalAlpha = 1;
        };

        const frame = (t: number) => {
            const dt = Math.min(t - last, 250);
            last = t;
            acc += dt;
            while (board && acc >= STEP_MS) {
                advance(board);
                acc -= STEP_MS;
            }
            draw(dt);
            raf = requestAnimationFrame(frame);
        };

        const resize = () => {
            const rect = holder.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            const cols = Math.max(4, Math.ceil(rect.width / CELL));
            const rows = Math.max(4, Math.ceil(rect.height / CELL));
            canvas.width = Math.ceil(cols * CELL * dpr);
            canvas.height = Math.ceil(rows * CELL * dpr);
            canvas.style.width = `${cols * CELL}px`;
            canvas.style.height = `${rows * CELL}px`;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            fg = themeColor("--k-text-white", fg);
            accent = themeColor("--k-accent", accent);
            board = newBoard(cols, rows, board ?? undefined);
            if (still) {
                // One frame that already looks lived in, then nothing moves.
                for (let g = 0; g < 40; g++) advance(board);
                for (let i = 0; i < board.shade.length; i++) board.shade[i] = board.alive[i];
                board.glow.fill(0);
                draw(0);
            }
        };

        // ── Playing with it. The screen's own layers sit above the canvas, so the events are read from the
        // area that holds it, and count only when they land on bare background, not on a card or a button.
        const onBackground = (target: EventTarget | null) => target instanceof HTMLElement && target.hasAttribute("data-life-surface");
        // A press on the scrollbar of the scrolling layer is the scrollbar's, not the background's.
        const onScrollbar = (e: PointerEvent) =>
            e.target instanceof HTMLElement && e.clientX - e.target.getBoundingClientRect().left > e.target.clientWidth;
        const cellAt = (e: PointerEvent) => {
            const rect = canvas.getBoundingClientRect();
            return { x: Math.floor((e.clientX - rect.left) / CELL), y: Math.floor((e.clientY - rect.top) / CELL) };
        };
        const onDown = (e: PointerEvent) => {
            if (e.button !== 0 || !board || !onBackground(e.target) || onScrollbar(e)) return;
            pressed = true;
            dragged = false;
            downCell = lastCell = cellAt(e);
            holder.setPointerCapture(e.pointerId);
        };
        const onMove = (e: PointerEvent) => {
            const over = onBackground(e.target) || pressed;
            hover = over ? cellAt(e) : null;
            if (!pressed || !board) return;
            const cell = cellAt(e);
            // Moving off the cell it went down on turns the click into a drag: draw a line of life.
            if (!dragged && (cell.x !== downCell.x || cell.y !== downCell.y)) {
                dragged = true;
                paintLine(board, downCell.x, downCell.y, cell.x, cell.y);
            } else if (dragged) {
                paintLine(board, lastCell.x, lastCell.y, cell.x, cell.y);
            }
            lastCell = cell;
        };
        const onUp = (e: PointerEvent) => {
            if (!pressed) return;
            pressed = false;
            if (holder.hasPointerCapture(e.pointerId)) holder.releasePointerCapture(e.pointerId);
            if (!dragged && board) {
                // A click: drop a random pattern, turned a random way, on the cell that was clicked.
                stamp(board, downCell.x, downCell.y, randomPattern().cells, Math.floor(Math.random() * 8));
            }
        };
        const onLeave = () => {
            hover = null;
        };

        // The Konami code. Global (not scoped to the background, unlike click-to-stamp above) so it
        // still works while a card or button has focus; never preventDefault/stopPropagation, so it
        // never interferes with normal typing or navigation, on the off chance those ten keys are
        // ever pressed in this exact order for an unrelated reason.
        let progress = 0;
        const onKeyDown = (e: KeyboardEvent) => {
            const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
            const want = KONAMI[progress];
            progress = key === want ? progress + 1 : key === KONAMI[0] ? 1 : 0;
            if (progress === KONAMI.length) {
                progress = 0;
                circles = !circles;
            }
        };

        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(holder);
        if (!still) {
            // Gated the same as the pointer listeners just below: reduced-motion mode draws one
            // still frame and never runs the draw loop again, so toggling circles here would have
            // nothing left to ever repaint — consistent with that mode already turning off all
            // interactivity, not just the animation itself.
            last = performance.now();
            raf = requestAnimationFrame(frame);
            window.addEventListener("keydown", onKeyDown);
            holder.addEventListener("pointerdown", onDown);
            holder.addEventListener("pointermove", onMove);
            holder.addEventListener("pointerup", onUp);
            holder.addEventListener("pointercancel", onUp);
            holder.addEventListener("pointerleave", onLeave);
        }
        return () => {
            cancelAnimationFrame(raf);
            observer.disconnect();
            window.removeEventListener("keydown", onKeyDown);
            holder.removeEventListener("pointerdown", onDown);
            holder.removeEventListener("pointermove", onMove);
            holder.removeEventListener("pointerup", onUp);
            holder.removeEventListener("pointercancel", onUp);
            holder.removeEventListener("pointerleave", onLeave);
        };
    }, []);

    // Behind everything, never in the way of a click.
    return <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 pointer-events-none" />;
}
