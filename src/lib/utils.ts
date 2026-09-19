import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

// Decode HTML entities for display (e.g., &#39; -> ', &amp; -> &)
export function decodeHtmlEntities(text: string): string {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = text;
    return textarea.value;
}

/**
 * Normalizes text for searching by converting to lowercase and 
 * standardizing punctuation characters (smart quotes, dashes, etc.)
 */
export function normalizeText(text: string): string {
    if (!text) return "";
    return text
        .toLowerCase()
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/…/g, "...")
        .replace(/[—–]/g, "-");
}

/** The folder part of a file path, for either separator (Windows paths use backslashes). */
export const parentDir = (path: string): string => path.replace(/[\\/][^\\/]*$/, "");

/** The name shown for a Drive in the tree: the last segment of its display path (":CRYPTO-DOAC" -> "DOAC"). */
export function driveSegmentLabel(displayPath: string): string {
    return displayPath.split('-').pop()?.replace(/^:/, '') || displayPath;
}
