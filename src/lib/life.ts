// Conway's Game of Life on a wrap-around board, kept endless: see components/workspace/LifeBackground.tsx,
// which draws it. Plain data and functions, so it can be tested without a browser.

export const START_DENSITY = 0.2;
const HISTORY = 12; // a state seen again within this many generations means it's stuck in a loop
const STUCK_AFTER = 14; // generations of repeating before a fresh patch is dropped in
const MIN_ALIVE = 0.004; // fewer live cells than this share of the board counts as dying out

export interface Board {
    cols: number;
    rows: number;
    alive: Uint8Array;
    next: Uint8Array;
    /** How visible each cell is right now (eases toward alive/dead). */
    shade: Float32Array;
    /** A short accent flash for cells that were just born. */
    glow: Float32Array;
    /** Hashes of the last few generations, to notice when the board has stopped changing. */
    recent: number[];
    stuck: number;
}

export function newBoard(cols: number, rows: number, from?: Board): Board {
    const size = cols * rows;
    const board: Board = {
        cols, rows,
        alive: new Uint8Array(size), next: new Uint8Array(size),
        shade: new Float32Array(size), glow: new Float32Array(size),
        recent: [], stuck: 0,
    };
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const i = y * cols + x;
            if (from && x < from.cols && y < from.rows) {
                // Keep what was already there where the board still overlaps it.
                const j = y * from.cols + x;
                board.alive[i] = from.alive[j];
                board.shade[i] = from.shade[j];
            } else {
                board.alive[i] = Math.random() < START_DENSITY ? 1 : 0;
            }
        }
    }
    return board;
}

/** Advances one generation (the edges wrap). Returns a hash of the new state and how many cells live. */
export function step(b: Board): { hash: number; alive: number } {
    const { cols, rows, alive, next, glow } = b;
    let hash = 0;
    let count = 0;
    for (let y = 0; y < rows; y++) {
        const up = ((y + rows - 1) % rows) * cols;
        const here = y * cols;
        const down = ((y + 1) % rows) * cols;
        for (let x = 0; x < cols; x++) {
            const l = (x + cols - 1) % cols;
            const r = (x + 1) % cols;
            const n = alive[up + l] + alive[up + x] + alive[up + r]
                + alive[here + l] + alive[here + r]
                + alive[down + l] + alive[down + x] + alive[down + r];
            const i = here + x;
            const lives = alive[i] ? (n === 2 || n === 3) : n === 3;
            next[i] = lives ? 1 : 0;
            if (lives) {
                count++;
                hash = (Math.imul(hash, 31) + i) | 0;
                if (!alive[i]) glow[i] = 1;
            }
        }
    }
    b.alive = next;
    b.next = alive;
    return { hash, alive: count };
}

/** Drops a patch of random cells at a random spot (over whatever is there), to restart the action. */
export function sow(b: Board) {
    const size = Math.max(10, Math.min(22, Math.floor(Math.min(b.cols, b.rows) / 3)));
    const x0 = Math.floor(Math.random() * b.cols);
    const y0 = Math.floor(Math.random() * b.rows);
    for (let dy = 0; dy < size; dy++) {
        for (let dx = 0; dx < size; dx++) {
            const i = ((y0 + dy) % b.rows) * b.cols + ((x0 + dx) % b.cols);
            if (Math.random() < 0.32) b.alive[i] = 1;
        }
    }
    b.recent = [];
    b.stuck = 0;
}

/** Steps once, and adds a fresh patch if the board has stopped changing or is nearly empty. */
export function advance(b: Board) {
    const { hash, alive } = step(b);
    b.stuck = b.recent.includes(hash) ? b.stuck + 1 : 0;
    b.recent.push(hash);
    if (b.recent.length > HISTORY) b.recent.shift();
    if (b.stuck >= STUCK_AFTER || alive < b.cols * b.rows * MIN_ALIVE) sow(b);
}

// ─── Things to drop onto the board ───────────────────────────────────────────

export type Pattern = ReadonlyArray<readonly [number, number]>;

/**
 * Famous Life patterns, as live cells. Dropped at random by a click: the glider and the spaceship set
 * off across the board, and the R-pentomino and the acorn are tiny starts that erupt into thousands of
 * generations of chaos (the acorn takes 5,206 of them to settle). The diehard fizzles out after 130.
 */
export const PATTERNS: { name: string; weight: number; cells: Pattern }[] = [
    { name: "glider", weight: 3, cells: [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]] },
    { name: "lightweight spaceship", weight: 2, cells: [[1, 0], [4, 0], [0, 1], [0, 2], [4, 2], [0, 3], [1, 3], [2, 3], [3, 3]] },
    { name: "R-pentomino", weight: 2, cells: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]] },
    { name: "acorn", weight: 1, cells: [[1, 0], [3, 1], [0, 2], [1, 2], [4, 2], [5, 2], [6, 2]] },
    { name: "diehard", weight: 1, cells: [[6, 0], [0, 1], [1, 1], [1, 2], [5, 2], [6, 2], [7, 2]] },
];

/** One of `PATTERNS`, favoring the ones that travel. `rand` is a number in [0, 1). */
export function randomPattern(rand: number = Math.random()): (typeof PATTERNS)[number] {
    const total = PATTERNS.reduce((sum, p) => sum + p.weight, 0);
    let pick = rand * total;
    for (const p of PATTERNS) {
        pick -= p.weight;
        if (pick < 0) return p;
    }
    return PATTERNS[0];
}

/**
 * Puts `cells` on the board centered on (cx, cy), turned one of eight ways (`orientation` 0-7: four
 * rotations, each optionally mirrored), wrapping at the edges. Every cell it turns on flashes.
 */
export function stamp(b: Board, cx: number, cy: number, cells: Pattern, orientation: number) {
    const width = Math.max(...cells.map(([x]) => x)) + 1;
    const height = Math.max(...cells.map(([, y]) => y)) + 1;
    for (const [px, py] of cells) {
        let x = px - Math.floor(width / 2);
        let y = py - Math.floor(height / 2);
        if (orientation >= 4) x = -x;
        for (let turn = 0; turn < orientation % 4; turn++) [x, y] = [-y, x];
        paint(b, cx + x, cy + y);
    }
    disturb(b);
}

/** Turns one cell on (wrapping at the edges) and flashes it. */
export function paint(b: Board, x: number, y: number) {
    const col = ((x % b.cols) + b.cols) % b.cols;
    const row = ((y % b.rows) + b.rows) % b.rows;
    const i = row * b.cols + col;
    if (!b.alive[i]) b.glow[i] = 1;
    b.alive[i] = 1;
}

/** Turns on every cell on the straight line between two cells, so a fast drag leaves no gaps. */
export function paintLine(b: Board, x0: number, y0: number, x1: number, y1: number) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let n = 0; n <= steps; n++) {
        paint(b, Math.round(x0 + ((x1 - x0) * n) / steps), Math.round(y0 + ((y1 - y0) * n) / steps));
    }
    disturb(b);
}

/** Says the board just changed by hand, so the check for "stuck" starts over instead of firing at once. */
export function disturb(b: Board) {
    b.recent = [];
    b.stuck = 0;
}
