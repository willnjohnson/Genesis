import { useEffect, useMemo, useState } from 'react';
import type { ElementType } from 'react';
import { Pencil, X, Globe, BookOpen, FileText } from 'lucide-react';
import { BsTwitterX, BsInstagram, BsFacebook, BsYoutube, BsTiktok, BsThreads, BsTwitch, BsReddit, BsDiscord } from 'react-icons/bs';
import { SiWikipedia } from 'react-icons/si';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getBiographies, updateBiography, type BiographyEntry, fetchChannelVideosV3, openExternalUrl } from '../api';
import { normalizeText } from '../lib/utils';
import { handleMarkdownKeyDown } from './Sidebar';

type EditableBiography = BiographyEntry | null;
type SocialTab = 'wikipedia' | 'website' | 'twitter' | 'instagram' | 'facebook' | 'threads' | 'youtube' | 'tiktok' | 'twitch' | 'reddit' | 'discord';
type SocialKey = 'wikipedia' | 'website' | 'twitter' | 'instagram' | 'facebook' | 'threads' | 'youtube' | 'tiktok' | 'twitch' | 'reddit' | 'discord';

const socialConfig: Record<SocialKey, { icon: ElementType; label: string }> = {
    website: { icon: Globe, label: 'Website' },
    wikipedia: { icon: SiWikipedia, label: 'Wikipedia' },
    twitter: { icon: BsTwitterX, label: 'X' },
    instagram: { icon: BsInstagram, label: 'Instagram' },
    facebook: { icon: BsFacebook, label: 'Facebook' },
    threads: { icon: BsThreads, label: 'Threads' },
    youtube: { icon: BsYoutube, label: 'YouTube' },
    tiktok: { icon: BsTiktok, label: 'TikTok' },
    twitch: { icon: BsTwitch, label: 'Twitch' },
    reddit: { icon: BsReddit, label: 'Reddit' },
    discord: { icon: BsDiscord, label: 'Discord' },
};

const socialOrder: SocialKey[] = ['website', 'wikipedia', 'twitter', 'instagram', 'facebook', 'threads', 'youtube', 'tiktok', 'twitch', 'reddit', 'discord'];

const getSocialValue = (bio: BiographyEntry, key: SocialKey): string => {
    return bio[key]?.trim() || '';
};

const socialTabConfig: Record<SocialTab, { icon: ElementType; label: string; placeholder: string; fullUrl: boolean }> = {
    website: { icon: Globe, label: 'Website', placeholder: 'https://example.com', fullUrl: true },
    wikipedia: { icon: SiWikipedia, label: 'Wikipedia', placeholder: 'https://wikipedia.org/...', fullUrl: true },
    twitter: { icon: BsTwitterX, label: 'X', placeholder: 'username', fullUrl: false },
    instagram: { icon: BsInstagram, label: 'Instagram', placeholder: 'username', fullUrl: false },
    facebook: { icon: BsFacebook, label: 'Facebook', placeholder: 'username or page', fullUrl: false },
    threads: { icon: BsThreads, label: 'Threads', placeholder: 'username', fullUrl: false },
    youtube: { icon: BsYoutube, label: 'YouTube', placeholder: '@handle or channel ID', fullUrl: false },
    tiktok: { icon: BsTiktok, label: 'TikTok', placeholder: '@username', fullUrl: false },
    twitch: { icon: BsTwitch, label: 'Twitch', placeholder: 'username', fullUrl: false },
    reddit: { icon: BsReddit, label: 'Reddit', placeholder: 'r/subreddit', fullUrl: false },
    discord: { icon: BsDiscord, label: 'Discord', placeholder: 'server invite', fullUrl: false },
};

const socialTabs: SocialTab[] = ['website', 'wikipedia', 'twitter', 'instagram', 'facebook', 'threads', 'youtube', 'tiktok', 'twitch', 'reddit', 'discord'];

export function BiographyView({ searchQuery, onChange, onVideoSelect, onViewMore, allowEditBio }: { searchQuery: string; onChange?: () => void; onVideoSelect?: (video: Video) => void; onViewMore?: (handle: string) => void; allowEditBio?: boolean }) {
    const [entries, setEntries] = useState<BiographyEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<BiographyEntry | null>(null);
    const [editing, setEditing] = useState<EditableBiography>(null);
    const [activeSocialTab, setActiveSocialTab] = useState<SocialTab>('website');
    const [selectedVideos, setSelectedVideos] = useState<Video[]>([]);
    const [videosLoading, setVideosLoading] = useState(false);

    const loadEntries = async () => {
        try {
            const rows = await getBiographies();
            setEntries(rows);
        } catch (error) {
            console.error('Failed to load biographies:', error);
            setEntries([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadEntries();
    }, []);

    const filtered = useMemo(() => {
        const isBioSearch = searchQuery.includes('bio_search:');
        const q = normalizeText(searchQuery.replace(/person_search:/g, '').replace(/bio_search:/g, '').replace(/"/g, '').trim());
        if (!q) return entries;
        return entries.filter((item) => {
            if (isBioSearch) return normalizeText(item.bio || '').includes(q);
            return normalizeText(`${item.displayName} ${item.handle}`).includes(q);
        });
    }, [entries, searchQuery]);

    const grouped = useMemo(() => {
        const groups: Record<string, BiographyEntry[]> = {};
        for (const item of filtered) {
            const text = item.displayName.trim() || item.handle;
            const first = text.charAt(0).toUpperCase();
            const key = /[A-Z]/.test(first) ? first : '#';
            if (!groups[key]) groups[key] = [];
            groups[key].push(item);
        }
        return groups;
    }, [filtered]);

    const groupKeys = Object.keys(grouped).sort((a, b) => {
        if (a === '#') return -1;
        if (b === '#') return 1;
        return a.localeCompare(b);
    });

    useEffect(() => {
        if (selected) {
            fetchVideosForHandle(selected.handle);
        } else {
            setSelectedVideos([]);
        }
    }, [selected]);

    const saveEdit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!editing) return;

        // Normalize social fields: convert handles to full URLs where needed
        const normalized = { ...editing };
        (socialTabs as SocialTab[]).forEach((key) => {
            const val = editing[key];
            if (val && val.trim()) {
                normalized[key] = normalizeSocialValue(key, val.trim());
            }
        });

        await updateBiography(normalized);
        setEditing(null);
        await loadEntries();
        onChange?.();
    };

    const fetchVideosForHandle = async (handle: string) => {
        setVideosLoading(true);
        try {
            const response = await fetchChannelVideosV3(handle);
            setSelectedVideos(response.videos.slice(0, 6)); // Get latest 6 videos
        } catch (error) {
            console.error('Failed to fetch videos for handle:', error);
            setSelectedVideos([]);
        } finally {
            setVideosLoading(false);
        }
    };

    const normalizeSocialValue = (key: SocialTab, value: string): string => {
        if (!value) return '';
        if (key === 'website' || key === 'wikipedia') {
            return value.startsWith('http') ? value : `https://${value}`;
        } else {
            // If value is already a full URL, return as-is
            if (value.startsWith('http://') || value.startsWith('https://')) {
                return value;
            }
            // Platform handles: strip leading @ and build full URL
            const handle = value.startsWith('@') ? value.slice(1) : value;
            const prefixes: Record<SocialTab, string> = {
                twitter: 'https://twitter.com/',
                instagram: 'https://instagram.com/',
                facebook: 'https://facebook.com/',
                threads: 'https://threads.net/@',
                youtube: 'https://youtube.com/@',
                tiktok: 'https://tiktok.com/@',
                twitch: 'https://twitch.tv/',
                reddit: 'https://reddit.com/',
                discord: 'https://discord.gg/',
                website: '',
                wikipedia: '',
            };
            return prefixes[key] + handle;
        }
    };

    if (loading) return (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-400">
            <div className="flex justify-between items-center mb-6 max-w-5xl mx-auto px-4">
                <h2 className="text-xl font-bold text-white">Biography</h2>
            </div>
            <div className="max-w-5xl mx-auto px-4">
                <div className="text-center text-gray-500 py-24 bg-[#121212] rounded-xl border border-[#272727]">
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                    <p className="text-sm">Loading biographies...</p>
                </div>
            </div>
        </div>
    );

    return (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-400">
            <div className="flex justify-between items-center mb-6 max-w-5xl mx-auto px-4">
                <h2 className="text-xl font-bold text-white">Biography</h2>
            </div>

            <div className="max-w-5xl mx-auto px-4">
                {entries.length === 0 ? (
                    <div className="text-center text-gray-500 py-24 bg-[#121212] rounded-xl border border-[#272727]">
                        <p className="text-xl font-bold text-white mb-2">No people yet</p>
                        <p className="text-sm">People are added automatically when videos with handles are saved.</p>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="text-center text-gray-500 py-24 bg-[#121212] rounded-xl border border-[#272727]">
                        <p className="text-xl font-bold text-white mb-2">No people found</p>
                        <p className="text-md">No biographies match your search.</p>
                    </div>
                ) : (
                    <div className="space-y-8">
                        {groupKeys.map((char) => (
                            <div key={char}>
                                <h3 className="text-xl font-bold text-[#aaaaaa] border-b border-[#333] pb-2 mb-4">{char}</h3>
                        <ul className="space-y-1.5 pl-2">
                            {grouped[char].map((person) => (
                                <li key={person.handle} className="text-gray-300 group flex items-center">
                                    <div className="w-1.5 h-1.5 rounded-full bg-[#444] mr-3 shrink-0 group-hover:bg-red-400 transition-colors"></div>
                                     <button
                                         onClick={() => setSelected(person)}
                                         className="flex-1 text-left cursor-pointer"
                                     >
                                         <span className="group-hover:underline group-hover:decoration-dotted group-hover:underline-offset-4 group-hover:text-red-400 transition-all text-base font-medium">
                                             {person.displayName || person.handle}
                                         </span>
                                         <span className="ml-1.5 text-xs text-gray-500">({person.handle})</span>
                                     </button>
                                     {allowEditBio !== false && (
                                         <button
                                             onClick={(e) => {
                                                 e.stopPropagation();
                                                 setEditing(person);
                                                 setActiveSocialTab('website');
                                             }}
                                             className="text-gray-500 hover:text-blue-400 transition-colors cursor-pointer p-1"
                                             title="Edit bio"
                                         >
                                             <Pencil className="w-3.5 h-3.5" />
                                         </button>
                                     )}
                                </li>
                            ))}
                        </ul>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {selected && (
                <BiographyModal
                    biography={selected}
                    onClose={() => setSelected(null)}
                    onVideoSelect={(video) => {
                        setSelected(null);
                        onVideoSelect?.(video);
                    }}
                    onEdit={() => {
                        setEditing(selected);
                        setActiveSocialTab('website');
                        setSelected(null);
                    }}
                    onViewMore={onViewMore}
                    allowEditBio={allowEditBio}
                />
            )}

            {editing && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 animate-in fade-in duration-200" onClick={() => setEditing(null)}>
                    <form onSubmit={saveEdit} onClick={(e) => e.stopPropagation()} className="bg-white dark:bg-[#0f0f0f] border border-gray-200 dark:border-[#303030] rounded-2xl w-full max-w-3xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
                <div className="px-6 py-4 border-b border-gray-200 dark:border-[#303030] flex items-center justify-between bg-gray-100 dark:bg-[#141414]">
                            <div className="text-black dark:text-gray-200">
                                <h2 className="text-lg font-bold">Edit Bio</h2>
                                <p className="text-xs text-gray-500 dark:text-gray-400">{editing.displayName || editing.handle} ({editing.handle})</p>
                            </div>
                            <button type="button" onClick={() => setEditing(null)} className="text-gray-500 dark:text-gray-500 hover:text-black dark:hover:text-white transition-colors cursor-pointer">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-6 max-h-[75vh] overflow-y-auto">
                            {/* Bio - largest section */}
                            <div className="mb-6">
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Bio</label>
                                <textarea
                                    value={editing?.bio || ''}
                                    onChange={(e) => setEditing(prev => ({ ...prev, bio: e.target.value }))}
                                    onKeyDown={(e) => handleMarkdownKeyDown(e, editing?.bio || '', (val) => setEditing(prev => ({ ...prev, bio: val })))}
                                    rows={12}
                                    className="w-full bg-gray-100 dark:bg-[#121212] border border-gray-300 dark:border-[#333] text-black dark:text-white rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-600 transition-all resize-none placeholder-gray-500 dark:placeholder-gray-600"
                                    placeholder="Describe who this person is (Markdown supported)..."
                                />
                            </div>

                            {/* Social Tabs */}
                            <div className="mb-4">
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Socials</label>
                                <div className="flex gap-1 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-[#333] scrollbar-track-transparent">
                                    {socialTabs.map((tab) => {
                                        const config = socialTabConfig[tab];
                                        const Icon = config.icon;
                                        const isActive = activeSocialTab === tab;
                                        return (
                                             <button
                                                 key={tab}
                                                 type="button"
                                                 onClick={() => setActiveSocialTab(tab)}
                                                 title={config.label}
                                                  className={`flex items-center justify-center w-10 h-10 rounded-lg shrink-0 transition-colors cursor-pointer ${
                                                      isActive
                                                          ? 'bg-blue-600 text-white'
                                                          : 'bg-gray-200 dark:bg-[#1b1b1b] border border-gray-300 dark:border-[#333] text-gray-600 dark:text-gray-400 hover:text-black dark:hover:text-white hover:bg-gray-300 dark:hover:bg-[#262626]'
                                                  }`}
                                             >
                                                 <Icon className="w-5 h-5" />
                                             </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Active Social Input */}
                            <div>
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">
                                    {socialTabConfig[activeSocialTab].label}
                                </label>
                                <input
                                    type="text"
                                    value={editing ? (editing[activeSocialTab] || '') : ''}
                                    onChange={(e) => setEditing({ ...editing, [activeSocialTab]: e.target.value })}
                                    className="w-full bg-gray-100 dark:bg-[#121212] border border-gray-300 dark:border-[#333] text-black dark:text-white rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-600 transition-all placeholder-gray-500 dark:placeholder-gray-600"
                                    placeholder={socialTabConfig[activeSocialTab].placeholder}
                                />
                            </div>
                        </div>

                        <div className="px-6 py-4 border-t border-gray-200 dark:border-[#303030] flex justify-end gap-3 bg-gray-100 dark:bg-[#141414]">
                            <button type="button" onClick={() => setEditing(null)} className="px-4 py-2 rounded-lg bg-gray-200 dark:bg-[#222222] border border-gray-300 dark:border-[#383838] hover:bg-gray-300 dark:hover:bg-[#3f3f3f] cursor-pointer text-black dark:text-white text-sm font-semibold transition-colors">Cancel</button>
                            <button type="submit" className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-all text-sm font-bold cursor-pointer">Save Bio</button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}

export function BiographyModal({ biography, onClose, onVideoSelect, onEdit, onViewMore, allowEditBio }: { biography: BiographyEntry; onClose: () => void; onVideoSelect?: (video: Video) => void; onEdit?: () => void; onViewMore?: (handle: string) => void; allowEditBio?: boolean }) {
    const title = biography.displayName.trim() || biography.handle;
    const [videos, setVideos] = useState<Video[]>([]);
    const [loadingVideos, setLoadingVideos] = useState(true);

    const activeSocials = socialOrder.filter(key => getSocialValue(biography, key));

    useEffect(() => {
        let cancelled = false;
        const loadVideos = async () => {
            setLoadingVideos(true);
            try {
                const response = await fetchChannelVideosV3(biography.handle);
                if (!cancelled) {
                    setVideos(response.videos.slice(0, 5)); // Show latest 5 videos
                }
            } catch (error) {
                console.error('Failed to load channel videos:', error);
                if (!cancelled) {
                    setVideos([]);
                }
            } finally {
                if (!cancelled) {
                    setLoadingVideos(false);
                }
            };
        };

        loadVideos();
        return () => {
            cancelled = true;
        };
    }, [biography.handle]);

    const handleVideoClick = (video: Video) => {
        onClose();
        onVideoSelect?.(video);
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 animate-in fade-in duration-200" onClick={onClose}>
            <div onClick={(e) => e.stopPropagation()} className="bg-white dark:bg-[#0f0f0f] border border-gray-200 dark:border-[#303030] rounded-2xl w-full max-w-[1400px] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 h-[90vh]">
                        <div className="px-6 py-4 border-b border-gray-200 dark:border-[#303030] flex items-center justify-between bg-gray-100 dark:bg-[#141414]">
                    <div className="flex items-center gap-3 pr-4 overflow-hidden">
                        <FileText className="w-5 h-5 text-gray-400 shrink-0" />
                        <h2 className="text-xl font-bold text-black dark:text-white truncate">{title}</h2>
                        <span className="text-xs text-gray-500 dark:text-gray-400">{biography.handle}</span>
                    </div>
                     <div className="flex items-center gap-2">
                         {onEdit && allowEditBio !== false && (
                             <button onClick={onEdit} className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white cursor-pointer">
                                 Edit Bio
                             </button>
                         )}
                         <button onClick={onClose} className="text-gray-500 dark:text-gray-500 hover:text-black dark:hover:text-white transition-colors cursor-pointer">
                             <X className="w-5 h-5" />
                         </button>
                     </div>
                </div>

                 <div className="flex-1 flex flex-row min-h-0">
                     {/* Main Content: Bio */}
                      <div className="flex-1 border-r border-gray-200 dark:border-[#272727] overflow-y-auto p-6">
                          <h3 className="text-lg font-bold text-black dark:text-white mb-4">About</h3>
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
                                  {biography.bio?.trim() || '_No biography yet._'}
                              </ReactMarkdown>
                          </div>
                     </div>

                      {/* Sidebar Content: Latest Videos */}
                      <div className="w-96 bg-gray-50 dark:bg-[#0f0f0f] flex flex-col p-6 space-y-4">
                          <div className="flex items-center justify-between mb-4">
                              <h3 className="text-lg font-bold text-black dark:text-white">Latest Videos in Library</h3>
                             {videos.length > 0 && (
                                 <button
                                     onClick={() => {
                                         onViewMore?.(biography.handle);
                                         onClose();
                                     }}
                                      className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors cursor-pointer p-1"
                                 >
                                     View More
                                 </button>
                             )}
                         </div>

                         {loadingVideos ? (
                             <div className="flex items-center justify-center py-8">
                                  <div className="w-4 h-4 border-2 border-black dark:border-white border-t-transparent rounded-full animate-spin" />
                             </div>
                         ) : videos.length === 0 ? (
                              <div className="text-center text-gray-600 dark:text-gray-500 py-8">
                                 <p>No videos found for this channel</p>
                             </div>
                         ) : (
                             <div className="space-y-3 overflow-y-auto">
                                 {videos.map((video) => (
                                     <div
                                         key={video.id}
                                         onClick={() => handleVideoClick(video)}
                                         className="cursor-pointer flex gap-3 py-1"
                                     >
                                         {video.thumbnail ? (
                                             <img
                                                 src={video.thumbnail}
                                                 alt={video.title}
                                                 className="w-24 h-16 object-cover rounded-lg shrink-0"
                                             />
                                         ) : (
                                             <div className="w-24 h-16 bg-[#272727] rounded-lg flex items-center justify-center shrink-0">
                                                 <span className="text-xs text-gray-500">No Thumbnail</span>
                                             </div>
                                         )}
                                          <h4 className="text-sm text-black dark:text-white leading-tight flex-1">{video.title}</h4>
                                     </div>
                                 ))}
                             </div>
                         )}
                     </div>
                </div>

                {/* Sticky Footer: Social Icons */}
                {activeSocials.length > 0 && (
                    <div className="flex-shrink-0 border-t border-gray-200 dark:border-[#272727] bg-white dark:bg-[#0f0f0f] px-6 py-4">
                        <div className="flex flex-wrap gap-2">
                            {activeSocials.map((key) => {
                                const config = socialConfig[key];
                                const Icon = config.icon;
                                const rawValue = getSocialValue(biography, key);
                                return (
                                     <button
                                         key={key}
                                         onClick={() => openExternalUrl(rawValue)}
                                         title={config.label}
                                         className="flex items-center justify-center w-10 h-10 rounded-lg bg-gray-200 dark:bg-[#1b1b1b] border border-gray-300 dark:border-[#333] text-gray-600 dark:text-gray-400 hover:text-black dark:hover:text-white hover:bg-gray-300 dark:hover:bg-[#262626] hover:border-blue-600/50 transition-all cursor-pointer"
                                     >
                                        <Icon className="w-5 h-5" />
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
