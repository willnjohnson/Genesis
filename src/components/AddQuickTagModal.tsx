import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { saveGlossaryTerm } from '../api';
import { handlePlainContextMenu } from '../lib/markdown-editor';
import { Modal } from './Modal';

interface Props {
    onClose: () => void;
    onCreated: (tag: string) => void;
}

export function AddQuickTagModal({ onClose, onCreated }: Props) {
    const [tag, setTag] = useState('');
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault();
        const name = tag.trim();
        if (!name) return;
        try {
            await saveGlossaryTerm(null, name, '', []);
            onCreated(name);
        } catch (err) {
            setError(String(err));
        }
    };

    return (
        <Modal
            onClose={onClose}
            icon={Plus}
            title="Add Tag"
            onSubmit={handleSubmit}
            bodyClassName="p-6 space-y-6"
            footer={
                <>
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 rounded-lg bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] cursor-pointer text-white text-sm font-semibold transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        className="px-6 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white transition-all text-sm font-bold cursor-pointer"
                    >
                        Save Tag
                    </button>
                </>
            }
        >
            <div>
                <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Tag Name</label>
                <input
                    type="text"
                    autoFocus
                    required
                    value={tag}
                    onChange={event => setTag(event.target.value)}
                    onContextMenu={handlePlainContextMenu}
                    className="w-full bg-[#121212] border border-[#333] text-white rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-red-600 transition-all placeholder-gray-600"
                    placeholder="Enter term..."
                />
            </div>
            {error && <div className="text-xs text-red-400 bg-red-900/20 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
        </Modal>
    );
}