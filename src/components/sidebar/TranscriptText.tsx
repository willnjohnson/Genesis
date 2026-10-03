import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkHighlight } from '../../lib/remark-highlight';
import { remarkEmbeds } from '../../lib/remark-embeds';
import { remarkSourceLines } from '../../lib/preview-sync';
import { remarkTimestamps, splitTimestamps, SEEK_ATTR, TIMESTAMP_CLASS } from '../../lib/remark-timestamps';
import { markdownUrlTransform } from '../../lib/internal-links';
import { MarkdownLink } from '../MarkdownLink';

// Past this many characters a transcript is shown as plain text: rendering that much markdown at once
// can make the sidebar sluggish, and a transcript that long is almost certainly raw captions anyway.
const MAX_MARKDOWN_CHARS = 200_000;

/** Whether a transcript has markdown in it (a link, a heading, bold, a fenced block, a quote or a
 *  bullet list), as opposed to being plain captions. Plain ones are shown exactly as they are, since
 *  stray `*`, `_` and `#` in speech-to-text would otherwise be read as formatting. */
export function looksLikeMarkdown(text: string): boolean {
    return (
        /\]\((?:https?:|kinesis:|\/|#)/.test(text) ||
        /^ {0,3}#{1,6}[ \t]+\S/m.test(text) ||
        /\*\*[^*\n]+\*\*/.test(text) ||
        /==[^=\n]+==/.test(text) ||
        /^```/m.test(text) ||
        /^> /m.test(text) ||
        /(?:^[-*+] .+\n){2,}/m.test(text)
    );
}

interface Props {
    text: string;
    /** An image in the markdown was clicked (to enlarge it). */
    onImageClick?: (src: string) => void;
    /** Tags each block with its source line, so the editor's preview can be scrolled to a line (lib/preview-sync.ts). */
    sourceLines?: boolean;
}

/** The transcript as it's read: rendered as markdown when it contains any (so glossary links, headings
 *  and bold from the editor show up), otherwise the plain text it always was. */
export function TranscriptText({ text, onImageClick, sourceLines }: Props) {
    const markdown = useMemo(() => text.length <= MAX_MARKDOWN_CHARS && looksLikeMarkdown(text), [text]);
    // Plain captions stay plain text, apart from their [1:23] timestamps, which become the same chips the markdown
    // ones do (lib/remark-timestamps.ts) without the rest of the text being read as markdown.
    const plain = useMemo(() => (markdown ? null : splitTimestamps(text)), [markdown, text]);
    if (plain) {
        return (
            <>
                {plain.map((piece, i) => 'text' in piece
                    ? piece.text
                    : <button key={i} type="button" className={TIMESTAMP_CLASS} {...{ [SEEK_ATTR]: piece.seconds }} title={`Jump to ${piece.label}`}>{piece.label}</button>)}
            </>
        );
    }
    return (
        // whitespace-pre-line keeps every line break the transcript has (markdown would merge single
        // ones into a paragraph); prose gives headings, lists and paragraphs their spacing.
        <div className="leading-relaxed prose dark:prose-invert prose-sm max-w-none whitespace-pre-line">
            <ReactMarkdown
                remarkPlugins={sourceLines ? [remarkGfm, remarkHighlight, remarkTimestamps, remarkEmbeds, remarkSourceLines] : [remarkGfm, remarkHighlight, remarkTimestamps, remarkEmbeds]}
                urlTransform={markdownUrlTransform}
                components={{
                    a: MarkdownLink,
                    img: ({ node: _node, ...props }) => (
                        <img {...props} className="rounded-xl border border-white/10 cursor-pointer" onClick={() => onImageClick?.(props.src || '')} />
                    ),
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
}
