import type { ChangeEvent } from 'react';

// Enforces WDBS naming rules on a raw, already-edited input value: uppercase letters/digits/
// hyphen/colon only, a single leading colon (auto-prepended once there's other content, never
// allowed elsewhere), and no consecutive hyphens. Walks the string once, dropping disallowed
// characters, and counts how many were dropped ahead of the cursor so the caller can keep the
// cursor where the edit actually happened instead of letting it jump to the end.
export function sanitizeWdbsValue(raw: string, cursor: number): { value: string; cursor: number } {
    const upper = raw.toUpperCase();
    let out = '';
    let colonUsed = false;
    let removedBeforeCursor = 0;

    for (let i = 0; i < upper.length; i++) {
        const ch = upper[i];
        let keep: boolean;

        if (ch === ':') {
            keep = out.length === 0 && !colonUsed;
            if (keep) colonUsed = true;
        } else if (ch === '-') {
            keep = out[out.length - 1] !== '-';
        } else {
            keep = /[A-Z0-9]/.test(ch);
        }

        if (keep) {
            out += ch;
        } else if (i < cursor) {
            removedBeforeCursor++;
        }
    }

    let newCursor = cursor - removedBeforeCursor;
    if (out.length > 0 && out[0] !== ':') {
        out = ':' + out;
        newCursor += 1;
    }

    return { value: out, cursor: Math.max(0, Math.min(newCursor, out.length)) };
}

// Shared onChange for WDBS text inputs. Mutates the DOM input's value/selection directly before
// calling setState so React's re-render (which will see the same value it already finds in the
// DOM) doesn't reset the caret to the end of the field.
export function handleWdbsInputChange(e: ChangeEvent<HTMLInputElement>, setValue: (v: string) => void) {
    const input = e.target;
    const cursor = input.selectionStart ?? input.value.length;
    const { value, cursor: newCursor } = sanitizeWdbsValue(input.value, cursor);
    input.value = value;
    input.setSelectionRange(newCursor, newCursor);
    setValue(value);
}
