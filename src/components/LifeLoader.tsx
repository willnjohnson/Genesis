import { useEffect, useState } from "react";

/**
 * The app's loading animation for anything that takes a while (an import, an export, a sync, a
 * transcript): a 5x5 block of cells running Conway's Game of Life on a board that wraps at its edges,
 * the same one shown between workspaces (public/k-life.js — plain script, so its rules are repeated
 * there) and drawn like the board behind the Workspaces screen: plain squares in the theme's text
 * color that fade in and out, a newborn glowing in the accent color. Every theme gets it for free.
 * When it dies out or starts repeating it is seeded again.
 *
 * Motion stops for people who ask their system for reduced motion (one still frame).
 */

const SIZE = 5;
const STEP_MS = 150;

function seed(): boolean[] {
    let cells: boolean[];
    do {
        cells = Array.from({ length: SIZE * SIZE }, () => Math.random() < 0.34);
    } while (cells.filter(Boolean).length < 6);
    return cells;
}

function next(cells: boolean[]): boolean[] {
    return cells.map((alive, i) => {
        const x = i % SIZE;
        const y = Math.floor(i / SIZE);
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                if (cells[((y + dy + SIZE) % SIZE) * SIZE + ((x + dx + SIZE) % SIZE)]) n++;
            }
        }
        return alive ? n === 2 || n === 3 : n === 3;
    });
}

interface Props {
    /** One cell's width and height, in CSS pixels. */
    cell?: number;
    gap?: number;
    className?: string;
}

export function LifeLoader({ cell = 5, gap = 1, className = "" }: Props) {
    const [state, setState] = useState(() => ({ cells: seed(), born: [] as boolean[] }));

    useEffect(() => {
        if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
        let history: string[] = [];
        const timer = setInterval(() => {
            setState(({ cells }) => {
                const after = next(cells);
                const key = after.join();
                const stuck = after.filter(Boolean).length < 3 || history.includes(key);
                history = stuck ? [] : [...history, key].slice(-8);
                const cellsNow = stuck ? seed() : after;
                return { cells: cellsNow, born: cellsNow.map((alive, i) => alive && !cells[i]) };
            });
        }, STEP_MS);
        return () => clearInterval(timer);
    }, []);

    const side = SIZE * cell + (SIZE - 1) * gap;
    return (
        <div
            aria-hidden="true"
            className={`shrink-0 grid ${className}`}
            style={{ width: side, height: side, gridTemplate: `repeat(${SIZE}, ${cell}px) / repeat(${SIZE}, ${cell}px)`, gap }}
        >
            {state.cells.map((alive, i) => (
                <div
                    key={i}
                    style={{
                        // A newborn starts in the accent color and settles into the text color.
                        backgroundColor: state.born[i] ? "var(--k-accent)" : "var(--k-text-white)",
                        opacity: alive ? (state.born[i] ? 0.6 : 0.3) : 0,
                        transition: alive ? "background-color .24s ease-out, opacity .09s ease-out" : "opacity .32s ease-out",
                    }}
                />
            ))}
        </div>
    );
}
