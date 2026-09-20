import { useEffect, useMemo, useState } from "react";

/**
 * A pixel-art loading animation for anything that takes a while (an import, an export, a sync).
 * Two sprites, both drawn with the theme's own colors, so every theme (including imported ones)
 * gets it for free: the sprite is the theme's text color, on its background.
 *
 *  - "invader": a Space-Invader-style crab that marches back and forth, waving its legs.
 *  - "runner":  a little figure running on the spot over a moving ground line.
 *
 * Motion stops for people who ask their system for reduced motion (the sprite holds its first frame).
 */

export type PixelLoaderVariant = "invader" | "runner";

// One string per row, "#" a filled pixel. Every frame of a sprite has the same size.
const SPRITES: Record<PixelLoaderVariant, { frames: string[][]; frameMs: number; pixel: number }> = {
    invader: {
        frameMs: 380,
        pixel: 2,
        frames: [
            [
                "..#.....#..",
                "...#...#...",
                "..#######..",
                ".##.###.##.",
                "###########",
                "#.#######.#",
                "#.#.....#.#",
                "...##.##...",
            ],
            [
                "..#.....#..",
                "#..#...#..#",
                "#.#######.#",
                "###.###.###",
                "###########",
                ".#########.",
                "..#.....#..",
                ".#.......#.",
            ],
        ],
    },
    runner: {
        frameMs: 120,
        pixel: 3,
        frames: [
            [
                "...###..",
                "...###..",
                "....#...",
                ".#####..",
                "#..##.#.",
                "...##..#",
                "...##...",
                "..#..#..",
                ".#....#.",
                "#......#",
            ],
            [
                "...###..",
                "...###..",
                "....#...",
                "..####..",
                "..#.##..",
                "..#.##..",
                "...##...",
                "...###..",
                "..#..#..",
                ".##..##.",
            ],
            [
                "...###..",
                "...###..",
                "....#...",
                "..#####.",
                ".#.##..#",
                "#..##...",
                "...##...",
                "..#.#...",
                ".#...#..",
                "#.....##",
            ],
            [
                "...###..",
                "...###..",
                "....#...",
                "..####..",
                "...###..",
                "...##.#.",
                "...##...",
                "..###...",
                "..#..#..",
                ".##..##.",
            ],
        ],
    },
};

/** One SVG path for a frame: a 1x1 square for each filled pixel. */
function framePath(rows: string[]): string {
    let d = "";
    rows.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
            if (row[x] === "#") d += `M${x} ${y}h1v1h-1z`;
        }
    });
    return d;
}

function prefersReducedMotion(): boolean {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

interface Props {
    variant?: PixelLoaderVariant;
    /** Size of one pixel of the sprite, in CSS pixels (each sprite has its own default). */
    pixel?: number;
    /** The invader stays put (only its legs move) instead of marching along its lane. For a loader that sits centered on its own. */
    stationary?: boolean;
    className?: string;
}

/** The animation on its own: a small stage with the sprite (and, for the runner, its ground). */
export function PixelLoader({ variant = "invader", pixel: pixelSize, stationary = false, className = "" }: Props) {
    const { frames, frameMs, pixel: defaultPixel } = SPRITES[variant];
    const pixel = pixelSize ?? defaultPixel;
    const paths = useMemo(() => frames.map(framePath), [frames]);
    const [frame, setFrame] = useState(0);

    useEffect(() => {
        if (prefersReducedMotion()) return;
        const timer = setInterval(() => setFrame(f => (f + 1) % frames.length), frameMs);
        return () => clearInterval(timer);
    }, [frames.length, frameMs]);

    const cols = frames[0][0].length;
    const rows = frames[0].length;
    const width = cols * pixel;
    const height = rows * pixel;
    // The invader has a lane to march along (short, to suit its size); the runner stays put while the
    // ground scrolls under it.
    const marches = variant === "invader" && !stationary;
    const stageWidth = variant === "invader" ? (stationary ? width : width + 28) : width + 32;

    return (
        <div
            aria-hidden="true"
            className={`relative shrink-0 overflow-hidden ${className}`}
            style={{ width: stageWidth, height: height + 8, color: "var(--k-text-white)" }}
        >
            <div
                className={marches ? "k-pixel-march" : ""}
                style={{
                    position: "absolute",
                    // Centered in its stage; the march swings evenly to either side of this, so it rests
                    // in the middle (and stays there when animation is turned off).
                    left: (stageWidth - width) / 2,
                    top: variant === "invader" ? 2 : 0,
                    // How far the invader walks: the lane's spare width, in whole pixels of the sprite.
                    ["--k-march" as string]: `${stageWidth - width}px`,
                }}
            >
                <svg
                    width={width}
                    height={height}
                    viewBox={`0 0 ${cols} ${rows}`}
                    shapeRendering="crispEdges"
                    fill="currentColor"
                    style={{ display: "block" }}
                >
                    <path d={paths[frame % paths.length]} />
                </svg>
            </div>
            {variant === "runner" && <div className="k-pixel-ground" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2 }} />}
        </div>
    );
}
