import { X, FileText, Hash, Type, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import React, { useEffect, useState } from 'react';
import { openExternalUrl, getSetting } from '../api';

interface GlossaryTerm {
    term: string;
    definition: string;
}

interface Props {
    term: GlossaryTerm;
    onClose: () => void;
    onSearch: (term: string, mode: 'title' | 'transcript' | 'tag' | 'summary') => void;
}

export function TermDefinitionModal({ term, onClose, onSearch }: Props) {
    const [showTag, setShowTag] = useState(true);
    const [showTitle, setShowTitle] = useState(true);
    const [showTranscript, setShowTranscript] = useState(true);
    const [showSummary, setShowSummary] = useState(true);

    useEffect(() => {
        getSetting('showGlossarySearchByTag').then(v => { if (v === 'false') setShowTag(false); });
        getSetting('showGlossarySearchTermInTitle').then(v => { if (v === 'false') setShowTitle(false); });
        getSetting('showGlossarySearchTermInTranscript').then(v => { if (v === 'false') setShowTranscript(false); });
        getSetting('showGlossarySearchTermInAISummary').then(v => { if (v === 'false') setShowSummary(false); });
    }, []);

    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 animate-in fade-in duration-200"
            onClick={onClose}
        >
            <div
                onClick={e => e.stopPropagation()}
                className="bg-[#0f0f0f] border border-[#303030] rounded-2xl w-full max-w-7xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 h-[90vh]"
            >
                {/* Header */}
                <div className="px-6 py-4 border-b border-[#303030] flex items-center justify-between bg-[#141414]">
                    <div className="flex items-center gap-3 pr-4 overflow-hidden">
                        <FileText className="w-5 h-5 text-gray-400 shrink-0" />
                        <h2 className="text-xl font-bold text-white truncate">{term.term}</h2>
                    </div>
                    <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors cursor-pointer">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 bg-[#0f0f0f] overflow-y-auto flex-1">
                    <div className="leading-relaxed prose dark:prose-invert prose-lg max-w-none prose-pre:bg-black/50 prose-code:text-red-400">
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                                a: ({ node, ...props }) => (
                                    <a
                                        {...props}
                                        href="#"
                                        onClick={(e) => {
                                            e.preventDefault();
                                            if (props.href) openExternalUrl(props.href);
                                        }}
                                        className="text-red-500 hover:text-red-400 underline decoration-red-500/30 underline-offset-4"
                                    />
                                ),
                                img: ({ node, ...props }) => (
                                    <img
                                        {...props}
                                        className="rounded-xl border border-white/10"
                                    />
                                )
                            }}
                        >
                            {term.definition}
                        </ReactMarkdown>
                    </div>
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-[#303030] flex justify-start items-center bg-[#141414]">
                    <div className="flex gap-3">
                        {showTag && (
                            <button
                                onClick={() => {
                                    onSearch(`${term.term}#`, 'tag');
                                    onClose();
                                }}
                                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-[#222] hover:bg-[#333] text-gray-200 transition-all text-xs font-bold cursor-pointer border border-[#333] hover:border-[#444]"
                            >
                                <Hash className="w-3.5 h-3.5" />
                                Search by Tag
                            </button>
                        )}
                        {showTitle && (
                            <button
                                onClick={() => {
                                    onSearch(term.term, 'title');
                                    onClose();
                                }}
                                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-[#222] hover:bg-[#333] text-gray-200 transition-all text-xs font-bold cursor-pointer border border-[#333] hover:border-[#444]"
                            >
                                <Type className="w-3.5 h-3.5" />
                                Search Term in Title
                            </button>
                        )}
                        {showTranscript && (
                            <button
                                onClick={() => {
                                    onSearch(term.term, 'transcript');
                                    onClose();
                                }}
                                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-[#222] hover:bg-[#333] text-gray-200 transition-all text-xs font-bold cursor-pointer border border-[#333] hover:border-[#444]"
                            >
                                <FileText className="w-3.5 h-3.5" />
                                Search Term in Transcript
                            </button>
                        )}
                        {showSummary && (
                            <button
                                onClick={() => {
                                    onSearch(term.term, 'summary');
                                    onClose();
                                }}
                                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-[#222] hover:bg-[#333] text-gray-200 transition-all text-xs font-bold cursor-pointer border border-[#333] hover:border-[#444]"
                            >
                                <Sparkles className="w-3.5 h-3.5" />
                                Search Term in AI Summary
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
