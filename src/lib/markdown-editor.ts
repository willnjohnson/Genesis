import type { KeyboardEvent } from 'react';

/**
 * Keyboard-shortcut handler for plain-textarea markdown editors (bold/italic/strikethrough/
 * link/image wrapping, and list/heading/blockquote line-prefixing). Shared by every markdown
 * textarea in the app (Sidebar's transcript/summary editors, glossary term definitions,
 * biography bio text).
 */
export const handleMarkdownKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>, value: string, setter: (val: string) => void) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') return;

    const target = e.currentTarget;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const selectedText = value.substring(start, end);

    const patterns: Record<string, { prefix: string; suffix: string; detect?: RegExp; defaultText?: string }> = {
        bold: { prefix: '**', suffix: '**', detect: /^\*\*(.*)\*\*$/s },
        italic: { prefix: '*', suffix: '*', detect: /^\*(.*)\*$/s },
        strikethrough: { prefix: '~~', suffix: '~~', detect: /^~~(.*)~~$/s },
        link: { prefix: '[', suffix: '](https://example.com)', defaultText: 'URL Title' },
        image: { prefix: '![', suffix: '](https://i.imgur.com/7Cn5qJG.png)', defaultText: 'Image' },
        blockquote: { prefix: '> ', suffix: '' },
    };

    const replaceSelection = (type: string, defaultText: string = "TEXT") => {
        e.preventDefault();
        const textToWrap = selectedText || patterns[type].defaultText || defaultText;
        const { prefix, suffix, detect } = patterns[type];

        let replacement: string;
        let newSelectionStart: number;
        let newSelectionEnd: number;

        if (selectedText && detect) {
            const match = selectedText.match(detect);
            if (match) {
                // Unwrap: remove markdown
                replacement = match[1];
                newSelectionStart = start;
                newSelectionEnd = start + replacement.length;
            } else {
                // Wrap: add markdown and select full formatted text
                replacement = prefix + selectedText + suffix;
                newSelectionStart = start;
                newSelectionEnd = start + replacement.length;
            }
        } else {
            // No selection: insert with placeholder, select only inner text
            replacement = prefix + textToWrap + suffix;
            newSelectionStart = start + prefix.length;
            newSelectionEnd = start + prefix.length + textToWrap.length;
        }

        target.focus();
        document.execCommand('insertText', false, replacement);
        setTimeout(() => {
            target.setSelectionRange(newSelectionStart, newSelectionEnd);
        }, 0);
    };

    const prependLines = (getPrefix: (index: number) => string, stripPattern?: RegExp) => {
        e.preventDefault();
        const beforeSelection = value.substring(0, start);
        const lineStart = beforeSelection.lastIndexOf('\n') + 1;
        const afterSelection = value.substring(end);
        const lineEndOffset = afterSelection.indexOf('\n');
        const lineEnd = lineEndOffset === -1 ? value.length : end + lineEndOffset;

        const linesToModify = value.substring(lineStart, lineEnd).split('\n');
        const modifiedLines = linesToModify.map((line, i) => {
            const prefix = getPrefix(i);
            if (stripPattern) {
                const stripped = line.replace(stripPattern, '');
                return prefix + stripped;
            }
            return prefix + line;
        });
        const modifiedText = modifiedLines.join('\n');

        // Replace the full line range with modified text
        target.focus();
        target.setSelectionRange(lineStart, lineEnd);
        document.execCommand('insertText', false, modifiedText);
        setTimeout(() => {
            target.setSelectionRange(lineStart, lineStart + modifiedText.length);
        }, 0);
    };

    if (e.ctrlKey || e.metaKey) {
        if (!e.shiftKey && !e.altKey) {
            if (e.key.toLowerCase() === 'b') replaceSelection('bold');
            else if (e.key.toLowerCase() === 'i') replaceSelection('italic');
            else if (e.key.toLowerCase() === 'k') replaceSelection('link');
            else if (e.key.toLowerCase() === 'l') replaceSelection('image');
        } else if (e.shiftKey && !e.altKey) {
            if (e.key.toLowerCase() === 'x') replaceSelection('strikethrough');
            else if (e.key.toLowerCase() === 'l') prependLines(() => "- ");
            else if (e.code === 'Digit7' || e.key === '&') prependLines((i) => `${i + 1}. `);
            else if (e.key === '.' || e.key === '>') prependLines(() => "> ");
        } else if (e.altKey && !e.shiftKey) {
            if (['1','2','3','4','5','6'].includes(e.key)) {
                e.preventDefault();
                const level = parseInt(e.key);
                prependLines(() => "#".repeat(level) + " ", /^#+\s*/);
            }
        }
    }
};
