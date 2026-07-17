import { useState, useCallback, useEffect, type RefObject } from 'react';

interface UseFindReplaceParams {
    isEditingTranscript: boolean;
    editedTranscript: string;
    editedSummary: string;
    setEditedTranscript: (value: string) => void;
    setEditedSummary: (value: string) => void;
    transcriptEditRef: RefObject<HTMLTextAreaElement | null>;
    summaryEditRef: RefObject<HTMLTextAreaElement | null>;
    transcriptBackdropRef: RefObject<HTMLDivElement | null>;
    summaryBackdropRef: RefObject<HTMLDivElement | null>;
}

/**
 * Find/replace logic shared by the transcript and summary markdown editors. Operates on
 * whichever one is currently active (`isEditingTranscript`), searching/replacing in its edited
 * text and reflecting the current match in its textarea and syntax-highlight backdrop.
 */
export function useFindReplace({
    isEditingTranscript,
    editedTranscript,
    editedSummary,
    setEditedTranscript,
    setEditedSummary,
    transcriptEditRef,
    summaryEditRef,
    transcriptBackdropRef,
    summaryBackdropRef,
}: UseFindReplaceParams) {
    const [findText, setFindText] = useState("");
    const [replaceText, setReplaceText] = useState("");
    const [matchCase, setMatchCase] = useState(false);
    const [matchWholeWord, setMatchWholeWord] = useState(false);
    const [searchIndices, setSearchIndices] = useState<{ start: number, end: number }[]>([]);
    const [currentSearchIndex, setCurrentSearchIndex] = useState(-1);
    const [showFindReplace, setShowFindReplace] = useState(false);

    const findMatches = useCallback(() => {
        const activeContent = isEditingTranscript ? editedTranscript : editedSummary;
        if (!findText) {
            setSearchIndices([]);
            setCurrentSearchIndex(-1);
            return;
        }

        const indices: { start: number, end: number }[] = [];
        let searchStr = findText;

        if (!matchCase) {
            searchStr = searchStr.toLowerCase();
        }

        const escapedFind = searchStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const patternStr = matchWholeWord
            ? `(?<![a-zA-Z0-9])${escapedFind}(?![a-zA-Z0-9])`
            : escapedFind;

        const pattern = new RegExp(patternStr, matchCase ? 'g' : 'gi');

        let match;
        while ((match = pattern.exec(activeContent)) !== null) {
            indices.push({ start: match.index, end: match.index + match[0].length });
            if (match.index === pattern.lastIndex) pattern.lastIndex++; // safety
        }

        setSearchIndices(indices);
        setCurrentSearchIndex(indices.length > 0 ? 0 : -1);
    }, [findText, matchCase, matchWholeWord, isEditingTranscript, editedTranscript, editedSummary]);

    useEffect(() => {
        findMatches();
    }, [findText, matchCase, matchWholeWord, isEditingTranscript, editedTranscript, editedSummary]);

    useEffect(() => {
        if (!showFindReplace) {
            setFindText('');
            setReplaceText('');
        }
    }, [showFindReplace]);

    const highlightMatch = (idx: number, preventFocus: boolean = false) => {
        const activeTextareaRef = isEditingTranscript ? transcriptEditRef : summaryEditRef;
        const match = searchIndices[idx];
        if (!match || !activeTextareaRef.current) return;

        const textarea = activeTextareaRef.current;
        if (!preventFocus) textarea.focus();
        textarea.setSelectionRange(match.start, match.end);

        // Ensure the selection is visible
        const fullText = isEditingTranscript ? editedTranscript : editedSummary;
        const textBeforeMatch = fullText.substring(0, match.start);
        const linesBefore = textBeforeMatch.split('\n').length;
        const totalLines = fullText.split('\n').length;

        // This is a naive way to scroll but works for basic cases
        textarea.scrollTop = (linesBefore / totalLines) * textarea.scrollHeight - (textarea.clientHeight / 2);

        const activeBackdropRef = isEditingTranscript ? transcriptBackdropRef : summaryBackdropRef;
        if (activeBackdropRef.current) {
            activeBackdropRef.current.scrollTop = textarea.scrollTop;
        }
    };

    const navigateMatch = (dir: 'next' | 'prev', preventFocus: boolean = false) => {
        if (searchIndices.length === 0) return;
        let nextIdx = currentSearchIndex;
        if (dir === 'next') nextIdx = (currentSearchIndex + 1) % searchIndices.length;
        else nextIdx = (currentSearchIndex - 1 + searchIndices.length) % searchIndices.length;

        setCurrentSearchIndex(nextIdx);
        highlightMatch(nextIdx, preventFocus);
    };

    const handleReplace = () => {
        if (searchIndices.length === 0 || currentSearchIndex === -1) return;
        const match = searchIndices[currentSearchIndex];
        const activeTextareaRef = isEditingTranscript ? transcriptEditRef : summaryEditRef;

        if (activeTextareaRef.current) {
            const textarea = activeTextareaRef.current;
            textarea.focus();
            textarea.setSelectionRange(match.start, match.end);
            document.execCommand('insertText', false, replaceText);
        } else {
            // Fallback if ref is missing
            const activeContent = isEditingTranscript ? editedTranscript : editedSummary;
            const newContent = activeContent.substring(0, match.start) + replaceText + activeContent.substring(match.end);
            if (isEditingTranscript) setEditedTranscript(newContent);
            else setEditedSummary(newContent);
        }
    };

    const handleReplaceAll = () => {
        if (!findText) return;
        const activeContent = isEditingTranscript ? editedTranscript : editedSummary;
        const searchStr = findText;
        const escapedFind = searchStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const patternStr = matchWholeWord
            ? `(?<![a-zA-Z0-9])${escapedFind}(?![a-zA-Z0-9])`
            : escapedFind;
        const pattern = new RegExp(patternStr, matchCase ? 'g' : 'gi');

        const newContent = activeContent.replace(pattern, replaceText);
        const activeTextareaRef = isEditingTranscript ? transcriptEditRef : summaryEditRef;

        if (activeTextareaRef.current) {
            const textarea = activeTextareaRef.current;
            textarea.focus();
            textarea.select();
            document.execCommand('insertText', false, newContent);
        } else {
            // Fallback
            if (isEditingTranscript) setEditedTranscript(newContent);
            else setEditedSummary(newContent);
        }
        setShowFindReplace(false);
    };

    return {
        findText, setFindText,
        replaceText, setReplaceText,
        matchCase, setMatchCase,
        matchWholeWord, setMatchWholeWord,
        searchIndices, currentSearchIndex,
        showFindReplace, setShowFindReplace,
        navigateMatch, handleReplace, handleReplaceAll,
    };
}
