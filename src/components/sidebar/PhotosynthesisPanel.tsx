import { useState, useEffect } from 'react';
import { Image as ImageIcon, Search, Loader2, Upload } from 'lucide-react';
import { uploadToImgur, generateImage as generateVeniceImage, searchPixabay, getPixabayApiKey, setPixabayApiKey as savePixabayApiKey, getVeniceApiKey, setVeniceApiKey as saveVeniceApiKey } from '../../api';
import { saveImageAs } from '../../lib/save-image-as';
import photosynthesisLogo from '../../assets/photosynthesis.png';

interface Props {
    showSynthesizeVenice: boolean;
    showSynthesizePixabay: boolean;
    showSynthesizeUpload: boolean;
    imageTab: 'venice' | 'pixabay' | 'upload';
    setImageTab: (tab: 'venice' | 'pixabay' | 'upload') => void;
    isEditingTranscript: boolean;
    isEditingSummary: boolean;
    editedTranscript: string;
    editedSummary: string;
    setEditedTranscript: (updater: (prev: string) => string) => void;
    setEditedSummary: (updater: (prev: string) => string) => void;
    onUploadError: (message: string, imageUrl: string) => void;
}

/**
 * The Photosynthesis image-tooling panel (Venice AI generation, Pixabay search, local upload),
 * shown in place of the video player while editing an AI summary. Inserting an image always
 * prepends markdown to whichever of transcript/summary is currently being edited; failures
 * uploading to Imgur are reported via `onUploadError` rather than shown here, since that error
 * modal must stay visible even if the user navigates away from this panel before it resolves.
 */
export function PhotosynthesisPanel({
    showSynthesizeVenice, showSynthesizePixabay, showSynthesizeUpload,
    imageTab, setImageTab,
    isEditingTranscript, isEditingSummary, editedTranscript, editedSummary,
    setEditedTranscript, setEditedSummary,
    onUploadError,
}: Props) {
    const [pixabayQuery, setPixabayQuery] = useState("");
    const [pixabayImages, setPixabayImages] = useState<any[]>([]);
    const [isPixabayLoading, setIsPixabayLoading] = useState(false);
    const [pixabayApiKey, setPixabayApiKey] = useState("");
    const [pixabayApiKeySaved, setPixabayApiKeySaved] = useState(false);
    const [isGeneratingImage, setIsGeneratingImage] = useState(false);
    const [generatedImage, setGeneratedImage] = useState<string | null>(null);
    const [imagePrompt, setImagePrompt] = useState("");
    const [isUploadingImage, setIsUploadingImage] = useState(false);
    const [veniceApiKey, setVeniceApiKeyLocal] = useState("");
    const [veniceApiKeySaved, setVeniceApiKeySaved] = useState(false);

    // Load previously-saved keys once, when the user first opens this panel (it only mounts on
    // demand, while editing a summary, rather than whenever the whole sidebar opens).
    useEffect(() => {
        getPixabayApiKey().then(key => {
            if (key) {
                setPixabayApiKey(key);
                setPixabayApiKeySaved(true);
            }
        });

        getVeniceApiKey().then(key => {
            if (key) {
                setVeniceApiKeyLocal(key);
                setVeniceApiKeySaved(true);
            }
        });
    }, []);

    const handlePixabaySearch = async () => {
        if (!pixabayQuery.trim()) return;
        setIsPixabayLoading(true);
        try {
            const images = await searchPixabay(pixabayQuery);
            setPixabayImages(images);
        } catch (e: any) {
            console.error("Pixabay search failed:", e);
        } finally {
            setIsPixabayLoading(false);
        }
    };

    const handleGenerateVeniceImage = async () => {
        if (!imagePrompt.trim()) return;
        setIsGeneratingImage(true);
        setGeneratedImage(null);
        try {
            const dataUri = await generateVeniceImage(imagePrompt);
            setGeneratedImage(dataUri);
        } catch (e: any) {
            console.error("Venice image gen failed:", e);
        } finally {
            setIsGeneratingImage(false);
        }
    };

    const handleAddImageToContent = async (imageUrl: string, tags: string) => {
        setIsUploadingImage(true);
        try {
            const imgurUrl = await uploadToImgur(imageUrl);
            const markdown = `![${tags}](${imgurUrl})\n\n`;
            if (isEditingTranscript) {
                setEditedTranscript(prev => markdown + prev);
            } else if (isEditingSummary) {
                setEditedSummary(prev => markdown + prev);
            }
        } catch (e: any) {
            if (imageTab === 'venice' || imageTab === 'pixabay') {
                onUploadError(e.message || 'Unknown error occurred', imageUrl);
            } else {
                console.error("Failed to add image:", e);
            }
        } finally {
            setIsUploadingImage(false);
        }
    };

    const handleSaveImageAsFile = async (url: string) => {
        await saveImageAs(url, {
            filters: [{ name: 'Image', extensions: ['webp'] }],
            defaultPath: 'generated-image.webp'
        });
    };

    const handleSaveVeniceApiKey = async () => {
        if (!veniceApiKey.trim()) return;
        try {
            await saveVeniceApiKey(veniceApiKey);
            setVeniceApiKeySaved(true);
        } catch (err) {
            console.error("Failed to save Venice API key:", err);
        }
    };

    const handleSavePixabayApiKey = async () => {
        if (!pixabayApiKey.trim()) return;
        try {
            await savePixabayApiKey(pixabayApiKey);
            setPixabayApiKeySaved(true);
        } catch (err) {
            console.error("Failed to save Pixabay API key:", err);
        }
    };

    return (
        <div className="flex flex-col h-full bg-transparent relative">
            {/* Image Tool Header */}
            <div className="px-6 py-4 border-b border-[#303030] flex flex-col gap-4 bg-white/5">
                <div className="flex items-center gap-2">
                    <img src={photosynthesisLogo} alt="Photosynthesis" className="w-5 h-5" />
                    <div className="flex flex-col -gap-0.5">
                        <span className="text-xs font-bold tracking-tight text-white">Photosynthesis</span>
                        <span className="text-[9px] text-gray-500 font-medium uppercase tracking-wider">Synthesize your photos with AI</span>
                    </div>
                </div>
                <div className="flex justify-between items-center">
                    <div className="flex gap-2">
                    {showSynthesizeVenice && (
                        <button
                            id="venice-tab-btn"
                            onClick={() => setImageTab('venice')}
                            className={`flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer px-4 py-2 rounded-lg ${imageTab === 'venice'
                                ? 'bg-red-600 text-white'
                                : 'bg-[#222222] text-[#888888] hover:text-white border border-[#383838]'}`}
                        >
                            <ImageIcon className="w-3 h-3" />
                            Venice
                        </button>
                    )}
                    {showSynthesizePixabay && (
                        <button
                            id="pixabay-tab-btn"
                            onClick={() => setImageTab('pixabay')}
                            className={`flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer px-4 py-2 rounded-lg ${imageTab === 'pixabay'
                                ? 'bg-blue-600 text-white'
                                : 'bg-[#222222] text-[#888888] hover:text-white border border-[#383838]'}`}
                        >
                            <Search className="w-3 h-3" />
                            Pixabay
                        </button>
                    )}
                    {showSynthesizeUpload && (
                        <button
                            id="upload-tab-btn"
                            onClick={() => setImageTab('upload')}
                            className={`flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer px-4 py-2 rounded-lg ${imageTab === 'upload'
                                ? 'bg-green-600 text-white'
                                : 'bg-[#222222] text-[#888888] hover:text-white border border-[#383838]'}`}
                        >
                            <Upload className="w-3 h-3" />
                            Upload
                        </button>
                    )}
                </div>
                <span className="text-[10px] font-bold uppercase tracking-widest text-[#666] italic">
                    {imageTab === 'venice' ? "Generate with AI" : imageTab === 'pixabay' ? "Search Photos" : "Upload Local"}
                </span>
            </div>
        </div>

        {/* Image Tool Content */}
            <div className="flex-1 overflow-y-auto p-6 custom-scrollbar bg-transparent">
                {imageTab === 'venice' ? (
                    <div className="space-y-4">
                        {!veniceApiKeySaved ? (
                            <div className="space-y-3">
                                <p className="text-[10px] font-bold uppercase tracking-wider text-[#888888]">Venice API Key</p>
                                <div className="flex gap-2">
                                    <input
                                        type="password"
                                        value={veniceApiKey}
                                        onChange={(e) => setVeniceApiKeyLocal(e.target.value)}
                                        placeholder="API Key..."
                                        className="flex-1 bg-[#222222] border border-[#383838] rounded-lg px-4 py-2 text-sm text-white placeholder-[#666666] focus:outline-none focus:border-red-500"
                                    />
                                    <button
                                        onClick={handleSaveVeniceApiKey}
                                        className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-bold hover:bg-red-500 transition-colors cursor-pointer"
                                    >
                                        Save
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <p className="text-[10px] font-bold uppercase tracking-wider text-[#888888]">Image Prompt</p>
                                <div className="flex flex-wrap gap-2">
                                    {['Infographic', 'Visual Poster', 'Concept Art', 'Scene Illustration', 'Data Viz', 'Flowchart', 'Whiteboard'].map(tag => (
                                        <button
                                            key={tag}
                                            onClick={() => {
                                                const content = isEditingTranscript ? editedTranscript : editedSummary;
                                                const type = isEditingTranscript ? "this transcript" : "this AI summary";
                                                setImagePrompt(`${tag} based on ${type}:\n\n${content}`);
                                            }}
                                            className="px-2 py-1 rounded-lg bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] cursor-pointer text-white text-xs font-semibold transition-colors"
                                        >
                                            {tag}
                                        </button>
                                    ))}
                                </div>
                                <textarea
                                    id="image-prompt-input"
                                    value={imagePrompt}
                                    onChange={(e) => setImagePrompt(e.target.value)}
                                    placeholder="Enter image prompt..."
                                    className="w-full h-48 bg-[#222222] border border-[#383838] rounded-lg px-4 py-2 text-sm text-white placeholder-[#666666] focus:outline-none focus:border-red-500 resize-none"
                                />
                                <div className="flex gap-2">
                                    <button
                                        id="generate-image-btn"
                                        onClick={handleGenerateVeniceImage}
                                        disabled={isGeneratingImage || !imagePrompt.trim()}
                                        className="bg-red-600 hover:bg-red-500 disabled:opacity-30 text-white px-4 py-2 rounded-lg text-sm font-bold transition-all flex items-center gap-2 cursor-pointer"
                                    >
                                        {isGeneratingImage ? <Loader2 className="w-4 h-4 animate-spin" /> : "Generate"}
                                    </button>
                                    <button
                                        onClick={() => setVeniceApiKeySaved(false)}
                                        className="bg-[#444] hover:bg-[#555] text-white px-3 py-2 rounded-lg text-sm font-bold transition-all cursor-pointer"
                                        title="Update API Key"
                                    >
                                        Edit Key
                                    </button>
                                </div>
                            </div>
                        )}

                        {generatedImage && (
                            <div className="flex flex-col gap-2 pt-4 border-t border-white/5">
                                <p className="text-[10px] font-bold uppercase tracking-wider text-[#888888]">Generated Image</p>
                                <div
                                    onClick={() => handleAddImageToContent(generatedImage, "AI Generated Image")}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        handleSaveImageAsFile(generatedImage);
                                    }}
                                    className="relative group rounded-lg overflow-hidden cursor-pointer inline-block w-full border border-white/5"
                                >
                                    <img
                                        src={generatedImage}
                                        alt="Generated"
                                        className="w-full rounded-lg"
                                        onContextMenu={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            handleSaveImageAsFile(generatedImage);
                                        }}
                                    />
                                    <div
                                        className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none"
                                    >
                                        <div className="pointer-events-none">
                                            {isUploadingImage ? <Loader2 className="w-6 h-6 animate-spin text-white" /> : <Upload className="w-6 h-6 text-white" />}
                                        </div>
                                    </div>
                                </div>
                                <p className="text-[10px] text-gray-500">Right-click to Save As • Click to Add to Content</p>
                            </div>
                        )}
                    </div>
                ) : imageTab === 'pixabay' ? (
                    <div className="space-y-4">
                        {!pixabayApiKeySaved ? (
                            <div className="space-y-3">
                                <p className="text-[10px] font-bold uppercase tracking-wider text-[#888888]">Pixabay API Key</p>
                                <div className="flex gap-2">
                                    <input
                                        id="pixabay-api-key-input"
                                        type="password"
                                        value={pixabayApiKey}
                                        onChange={(e) => setPixabayApiKey(e.target.value)}
                                        placeholder="API Key..."
                                        className="flex-1 bg-[#222222] border border-[#383838] rounded-lg px-4 py-2 text-sm text-white placeholder-[#666666] focus:outline-none focus:border-red-500"
                                    />
                                    <button
                                        id="save-pixabay-key-btn"
                                        onClick={handleSavePixabayApiKey}
                                        className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-bold hover:bg-green-500 transition-colors cursor-pointer"
                                    >
                                        Save
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <p className="text-[10px] font-bold uppercase tracking-wider text-[#888888]">Search Pixabay</p>
                                <div className="flex gap-2">
                                    <input
                                        id="pixabay-search-input"
                                        type="text"
                                        value={pixabayQuery}
                                        onChange={(e) => setPixabayQuery(e.target.value)}
                                        onKeyDown={(e) => e.key === 'Enter' && handlePixabaySearch()}
                                        placeholder="Search Pixabay..."
                                        className="flex-1 bg-[#222222] border border-[#383838] rounded-lg px-4 py-2 text-sm text-white placeholder-[#666666] focus:outline-none focus:border-red-500"
                                    />
                                    <button
                                        onClick={handlePixabaySearch}
                                        disabled={!pixabayQuery.trim() || isPixabayLoading}
                                        className="bg-blue-600 hover:bg-blue-500 disabled:opacity-30 text-white px-4 py-2 rounded-lg text-sm font-bold transition-all flex items-center gap-2 cursor-pointer"
                                    >
                                        {isPixabayLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Search"}
                                    </button>
                                    <button
                                        onClick={() => setPixabayApiKeySaved(false)}
                                        className="bg-[#444] hover:bg-[#555] text-white px-3 py-2 rounded-lg text-sm font-bold transition-all cursor-pointer"
                                        title="Update API Key"
                                    >
                                        Edit Key
                                    </button>
                                </div>

                                {isUploadingImage && (
                                    <div className="flex items-center justify-center py-2">
                                        <Loader2 className="w-4 h-4 animate-spin text-blue-500 mr-2" />
                                        <span className="text-xs text-blue-500">Uploading to Imgur...</span>
                                    </div>
                                )}

                                <div className="grid grid-cols-4 gap-2 max-h-[400px] overflow-y-auto pr-1 custom-scrollbar">
                                    {pixabayImages.map(img => (
                                        <div
                                            key={img.id}
                                            onClick={() => handleAddImageToContent(img.url, img.tags)}
                                            onContextMenu={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                handleSaveImageAsFile(img.url);
                                            }}
                                            className="relative group rounded-lg overflow-hidden cursor-pointer border border-white/5"
                                        >
                                            <img
                                                src={img.thumbnail}
                                                alt={img.tags}
                                                className="w-full h-20 object-cover"
                                                onContextMenu={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    handleSaveImageAsFile(img.url);
                                                }}
                                            />
                                            <div
                                                className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none"
                                            >
                                                {isUploadingImage ? <Loader2 className="w-4 h-4 animate-spin text-white" /> : <Upload className="w-4 h-4 text-white" />}
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                {pixabayImages.length === 0 && !isPixabayLoading && (
                                    <div className="flex flex-col items-center justify-center py-12 text-[#444]">
                                        <Search className="w-8 h-8 mb-2 opacity-20" />
                                        <p className="text-[10px] font-bold uppercase tracking-widest text-[#666]">No images found</p>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="h-full flex flex-col items-center justify-center space-y-6">
                        <div
                            onClick={() => document.getElementById('local-image-upload')?.click()}
                            onDragOver={(e) => { e.preventDefault(); }}
                            onDragLeave={(e) => { e.preventDefault(); }}
                            onDrop={async (e) => {
                                e.preventDefault();
                                const file = e.dataTransfer.files[0];
                                if (file && file.type.startsWith('image/')) {
                                    const reader = new FileReader();
                                    reader.onload = (re) => {
                                        const dataUri = re.target?.result as string;
                                        handleAddImageToContent(dataUri, file.name);
                                    };
                                    reader.readAsDataURL(file);
                                }
                            }}
                            className="w-full border-2 border-dashed border-[#383838] rounded-2xl p-12 flex flex-col items-center justify-center gap-4 cursor-pointer"
                        >
                            <div className="w-16 h-16 rounded-full bg-green-600/10 flex items-center justify-center">
                                {isUploadingImage ? <Loader2 className="w-8 h-8 animate-spin text-green-500" /> : <Upload className="w-8 h-8 text-green-500" />}
                            </div>
                            <div className="text-center">
                                <p className="text-sm font-bold text-white mb-1">Click or Drag Image</p>
                                <p className="text-[10px] text-[#666] uppercase tracking-widest">Supports PNG, JPG, WEBP</p>
                            </div>
                            <input
                                id="local-image-upload"
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) {
                                        const reader = new FileReader();
                                        reader.onload = (re) => {
                                            const dataUri = re.target?.result as string;
                                            handleAddImageToContent(dataUri, file.name);
                                        };
                                        reader.readAsDataURL(file);
                                    }
                                }}
                            />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
