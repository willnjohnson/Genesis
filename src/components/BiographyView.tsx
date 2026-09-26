import { useEffect, useMemo, useState } from 'react';
import type { ElementType, RefObject } from 'react';
import { Pencil, X, Globe, BookOpen, FileText } from 'lucide-react';
import { BsTwitterX, BsInstagram, BsFacebook, BsYoutube, BsTiktok, BsThreads, BsTwitch, BsReddit, BsDiscord } from 'react-icons/bs';
import { SiWikipedia } from 'react-icons/si';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkHighlight } from '../lib/remark-highlight';
import { markdownUrlTransform } from '../lib/internal-links';
import { MarkdownLink } from './MarkdownLink';
import { AlphabetJumpNav } from './AlphabetJumpNav';
import { getBiographies, updateBiography, type BiographyEntry, fetchChannelVideosV3, openExternalUrl, getHandleDrives, type HandleDrive } from '../api';
import { useFlags } from '../hooks/useFlags';
import { useWorkspace } from '../hooks/useWorkspace';
import { normalizeText, driveSegmentLabel } from '../lib/utils';
import { handleMarkdownKeyDown, handleMarkdownContextMenu } from '../lib/markdown-editor';

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

/** A social a line of pasted bio text can be auto-detected as, e.g. "Instagram: @handle" or
 *  "Twitter: https://x.com/handle". "X" is an alias for the same `twitter` field the UI already
 *  labels "X". youtube/reddit/discord aren't offered here — no line-prefix convention was given
 *  for them and the existing socials UI already covers adding them by hand. */
type DetectableSocial = 'twitter' | 'instagram' | 'facebook' | 'wikipedia' | 'threads' | 'tiktok' | 'twitch' | 'website';

const DETECTABLE_LABELS: Record<string, DetectableSocial> = {
    x: 'twitter',
    twitter: 'twitter',
    instagram: 'instagram',
    facebook: 'facebook',
    wikipedia: 'wikipedia',
    threads: 'threads',
    tiktok: 'tiktok',
    twitch: 'twitch',
    website: 'website',
};

// A URL only counts as a match when it's on the platform's own domain AND has a path beyond the
// bare domain (e.g. x.com/handle, not just x.com) — a naked domain isn't a link to anyone.
const PLATFORM_URL_PATTERNS: Partial<Record<DetectableSocial, RegExp>> = {
    twitter: /^(https?:\/\/)?(www\.)?(x\.com|twitter\.com)\/\S+/i,
    instagram: /^(https?:\/\/)?(www\.)?instagram\.com\/\S+/i,
    facebook: /^(https?:\/\/)?(www\.)?facebook\.com\/\S+/i,
    wikipedia: /^(https?:\/\/)?([a-z0-9-]+\.)?wikipedia\.org\/\S+/i,
    threads: /^(https?:\/\/)?(www\.)?threads\.(net|com)\/\S+/i,
    tiktok: /^(https?:\/\/)?(www\.)?tiktok\.com\/\S+/i,
    twitch: /^(https?:\/\/)?(www\.)?twitch\.tv\/\S+/i,
};

// Facebook and Wikipedia only make sense as a link (no bare "@handle" convention for either);
// the rest also accept a plain handle or @handle.
const URL_ONLY: ReadonlySet<DetectableSocial> = new Set(['facebook', 'wikipedia']);
const HANDLE_PATTERN = /^@?[A-Za-z0-9._-]{1,30}$/;
const WEBSITE_PATTERN = /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;

// A pasted description links a social with actual markdown, not a bare URL — "[Site.com](https://
// site.com/)" or "<https://site.com/>" rather than plain text. Unwrap those down to the URL itself
// before matching a platform's domain, or a real link would look like it failed the domain check.
const extractLinkTarget = (value: string): string => {
    const trimmed = value.trim();
    const mdLink = trimmed.match(/^\[[^\]]*\]\((\S+?)\)$/);
    if (mdLink) return mdLink[1];
    const autoLink = trimmed.match(/^<(\S+?)>$/);
    if (autoLink) return autoLink[1];
    return trimmed;
};

/** Validates `value` for `platform`, returning the piece to normalize/pin, or null if it doesn't
 *  look like a real handle/link for that platform. */
const matchSocialValue = (platform: DetectableSocial, value: string): string | null => {
    const trimmed = extractLinkTarget(value);
    if (!trimmed) return null;
    const urlPattern = PLATFORM_URL_PATTERNS[platform];
    if (urlPattern && urlPattern.test(trimmed)) return trimmed;
    if (platform === 'website') return WEBSITE_PATTERN.test(trimmed) ? trimmed : null;
    if (URL_ONLY.has(platform)) return null;
    return HANDLE_PATTERN.test(trimmed) ? trimmed : null;
};

interface DetectedSocial {
    platform: DetectableSocial;
    normalized: string;
}

/** Scans pasted/typed bio text for "Label: value" lines and returns the socials worth offering to
 *  pin — one per platform (first match wins), skipping anything that already matches what's
 *  already saved for that platform. */
const detectSocialCandidates = (bio: string, current: BiographyEntry): DetectedSocial[] => {
    const seen = new Set<DetectableSocial>();
    const candidates: DetectedSocial[] = [];
    for (const rawLine of bio.split('\n')) {
        const match = rawLine.trim().match(/^([A-Za-z]+)\s*:\s*(.+)$/);
        if (!match) continue;
        const platform = DETECTABLE_LABELS[match[1].toLowerCase()];
        if (!platform || seen.has(platform)) continue;
        const value = matchSocialValue(platform, match[2]);
        if (!value) continue;
        const normalized = normalizeSocialValue(platform, value);
        if ((current[platform] || '').trim() === normalized) continue;
        seen.add(platform);
        candidates.push({ platform, normalized });
    }
    return candidates;
};

export function BiographyView({ searchQuery, onChange, onVideoSelect, onViewMore, onDriveSelect, allowEditBio, scrollContainerRef }: { searchQuery: string; onChange?: () => void; onVideoSelect?: (video: Video) => void; onViewMore?: (handle: string) => void; onDriveSelect?: (path: string, label: string) => void; allowEditBio?: boolean; scrollContainerRef: RefObject<HTMLDivElement | null> }) {
    const { labels } = useWorkspace();
    const [entries, setEntries] = useState<BiographyEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<BiographyEntry | null>(null);
    const [editing, setEditing] = useState<EditableBiography>(null);
    const [activeSocialTab, setActiveSocialTab] = useState<SocialTab>('website');
    const [selectedVideos, setSelectedVideos] = useState<Video[]>([]);
    const [videosLoading, setVideosLoading] = useState(false);
    const [pendingSocialPins, setPendingSocialPins] = useState<DetectedSocial[] | null>(null);

    const loadEntries = async () => {
        try {
            const rows = await getBiographies();
            // Deduplicate entries based on handle (case-insensitive)
            const uniqueRows = new Map<string, BiographyEntry>();
            rows.forEach(row => {
                const key = row.handle.toLowerCase();
                if (!uniqueRows.has(key)) {
                    uniqueRows.set(key, row);
                }
            });
            setEntries(Array.from(uniqueRows.values()));
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

    const commitSave = async (entry: BiographyEntry) => {
        // Normalize social fields: convert handles to full URLs where needed
        const normalized = { ...entry };
        (socialTabs as SocialTab[]).forEach((key) => {
            const val = entry[key];
            if (val && val.trim()) {
                normalized[key] = normalizeSocialValue(key, val.trim());
            }
        });

        await updateBiography(normalized);
        setEditing(null);
        setPendingSocialPins(null);
        await loadEntries();
        onChange?.();
    };

    const saveEdit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!editing) return;

        const candidates = detectSocialCandidates(editing.bio || '', editing);
        if (candidates.length > 0) {
            setPendingSocialPins(candidates);
            return;
        }
        await commitSave(editing);
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

    // The bottom panel exists even before there's anything to jump to, same as it does for an
    // empty filtered view — no popping in once entries actually load.
    if (loading) return (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-400">
            <div className="flex justify-between items-center min-h-9 mb-4 px-2">
                <h2 className="text-xl font-bold text-white">{labels.aliasBiography}</h2>
            </div>
            <div className="px-2">
                <div className="text-center text-gray-500 py-24 bg-[#121212] rounded-xl border border-[#272727]">
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                    <p className="text-sm">Loading biographies...</p>
                </div>
            </div>
            <AlphabetJumpNav idPrefix="biography-az" available={[]} scrollContainerRef={scrollContainerRef} />
        </div>
    );

    return (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-400">
            {/* sticky top-0 (solid bg — this scrolls within App.tsx's shared content pane) keeps
                the heading visible instead of scrolling past with the list beneath it. */}
            <div className="sticky top-0 z-10 bg-[#0f0f0f] flex justify-between items-center min-h-9 mb-4 px-2">
                <h2 className="text-xl font-bold text-white">{labels.aliasBiography}</h2>
            </div>

            {/* pb-20: room at the very bottom for the floating back-to-top button (App.tsx), so it never sits
                on a row's edit/delete icons once scrolled all the way down. (AlphabetJumpNav, below, is a true fixed panel, always present, no longer part
                of this page's own scroll — its ~24px height has to be reserved here instead, or
                it'd sit over the last section once scrolled all the way down. */}
            <div className="px-2 pb-20">
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
                                <h3 id={`biography-az-${char}`} className="text-xl font-bold text-[#aaaaaa] border-b border-[#333] pb-2 mb-4 scroll-mt-4">{char}</h3>
                        <ul className="space-y-1.5 pl-2">
                            {grouped[char].map((person) => (
                                <li key={person.handle} className="text-gray-300 group flex items-center">
                                    <div className="w-1.5 h-1.5 rounded-full bg-[#444] mr-3 shrink-0 group-hover:bg-[var(--k-accent)] transition-colors"></div>
                                     <button
                                         onClick={() => setSelected(person)}
                                         className="flex-1 text-left cursor-pointer"
                                     >
                                         <span className="group-hover:underline group-hover:decoration-dotted group-hover:underline-offset-4 group-hover:text-[var(--k-accent)] transition-all text-base font-medium">
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

            <AlphabetJumpNav idPrefix="biography-az" available={groupKeys} scrollContainerRef={scrollContainerRef} />

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
                    onDriveSelect={onDriveSelect}
                    allowEditBio={allowEditBio}
                />
            )}

            {editing && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 animate-in fade-in duration-200" onClick={() => setEditing(null)}>
                    <form onSubmit={saveEdit} onClick={(e) => e.stopPropagation()} className="bg-[#0f0f0f] border border-[#303030] rounded-2xl w-full max-w-4xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
                <div className="px-6 py-4 border-b border-[#303030] flex items-center justify-between bg-[#141414]">
                            <div className="text-gray-200">
                                <h2 className="text-lg font-bold">Edit {labels.aliasBiographyItem}</h2>
                                <p className="text-xs text-gray-400">{editing.displayName || editing.handle} ({editing.handle})</p>
                            </div>
                            <button type="button" onClick={() => setEditing(null)} className="text-gray-500 hover:text-white transition-colors cursor-pointer">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-6 max-h-[75vh] overflow-y-auto">
                            {/* Bio - largest section */}
                            <div className="mb-6">
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Description</label>
                                <textarea
                                    value={editing?.bio || ''}
                                    onChange={(e) => setEditing(prev => ({ ...prev, bio: e.target.value }))}
                                    onContextMenu={handleMarkdownContextMenu}
                                    onKeyDown={(e) => handleMarkdownKeyDown(e, editing?.bio || '', (val) => setEditing(prev => ({ ...prev, bio: val })))}
                                    rows={16}
                                    className="w-full bg-[#121212] border border-[#333] text-white rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-600 transition-all resize-none placeholder-gray-600"
                                    placeholder="Describe who this person is (Markdown supported)... Tip: paste your existing YouTube channel description here as a starting point."
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
                                                          ? 'bg-blue-600'
                                                          : 'bg-[#1b1b1b] border border-[#333] text-gray-400 hover:text-white hover:bg-[#262626]'
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
                                    className="w-full bg-[#121212] border border-[#333] text-white rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-600 transition-all placeholder-gray-600"
                                    placeholder={socialTabConfig[activeSocialTab].placeholder}
                                />
                            </div>
                        </div>

                        <div className="px-6 py-4 border-t border-[#303030] flex justify-end gap-3 bg-[#141414]">
                            <button type="button" onClick={() => { setEditing(null); setPendingSocialPins(null); }} className="px-4 py-2 rounded-lg bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] cursor-pointer text-white text-sm font-semibold transition-colors">Cancel</button>
                            <button type="submit" className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 transition-all text-sm font-bold cursor-pointer">Save {labels.aliasBiographyItem}</button>
                        </div>
                    </form>

                    {pendingSocialPins && (
                        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 p-4 animate-in fade-in duration-200" onClick={() => setPendingSocialPins(null)}>
                            <div onClick={(e) => e.stopPropagation()} className="bg-[#0f0f0f] border border-[#303030] rounded-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
                                <div className="px-6 py-4 border-b border-[#303030] bg-[#141414]">
                                    <h3 className="text-base font-bold text-white">Social{pendingSocialPins.length > 1 ? 's' : ''} detected</h3>
                                    <p className="text-xs text-gray-400 mt-1">Would you like to pin the following?</p>
                                </div>
                                <ul className="px-6 py-4 space-y-2.5 max-h-64 overflow-y-auto">
                                    {pendingSocialPins.map((p) => {
                                        const Icon = socialConfig[p.platform].icon;
                                        return (
                                            <li key={p.platform} className="flex items-center gap-2.5 text-sm">
                                                <Icon className="w-4 h-4 text-gray-400 shrink-0" />
                                                <span className="font-semibold text-white shrink-0">{socialConfig[p.platform].label}:</span>
                                                <span className="text-gray-400 truncate">{p.normalized}</span>
                                            </li>
                                        );
                                    })}
                                </ul>
                                <div className="px-6 py-4 border-t border-[#303030] flex justify-end gap-3 bg-[#141414]">
                                    <button type="button" onClick={() => commitSave(editing)} className="px-4 py-2 rounded-lg bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] cursor-pointer text-white text-sm font-semibold transition-colors">Just Save</button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const merged = { ...editing };
                                            pendingSocialPins.forEach((p) => { merged[p.platform] = p.normalized; });
                                            commitSave(merged);
                                        }}
                                        className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 transition-all text-sm font-bold cursor-pointer"
                                    >
                                        Pin & Save
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export function BiographyModal({ biography, onClose, onVideoSelect, onEdit, onViewMore, onDriveSelect, allowEditBio }: { biography: BiographyEntry; onClose: () => void; onVideoSelect?: (video: Video) => void; onEdit?: () => void; onViewMore?: (handle: string) => void; onDriveSelect?: (path: string, label: string) => void; allowEditBio?: boolean }) {
    const title = biography.displayName.trim() || biography.handle;
    const [videos, setVideos] = useState<Video[]>([]);
    const [loadingVideos, setLoadingVideos] = useState(true);
    const [drives, setDrives] = useState<HandleDrive[]>([]);
    const { flags } = useFlags();
    const { labels } = useWorkspace();

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

    // The Drives this channel's saved videos are filed under. Skipped when the DB owner hides Drives.
    useEffect(() => {
        if (!flags.showDrive) {
            setDrives([]);
            return;
        }
        let cancelled = false;
        getHandleDrives(biography.handle)
            .then(result => { if (!cancelled) setDrives(result); })
            .catch(error => {
                console.error('Failed to load related drives:', error);
                if (!cancelled) setDrives([]);
            });
        return () => {
            cancelled = true;
        };
    }, [biography.handle, flags.showDrive]);

    const handleVideoClick = (video: Video) => {
        onClose();
        onVideoSelect?.(video);
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 animate-in fade-in duration-200" onClick={onClose}>
            <div onClick={(e) => e.stopPropagation()} className="bg-[#0f0f0f] border border-[#303030] rounded-2xl w-full max-w-7xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 h-[90vh]">
                        <div className="px-6 py-4 border-b border-[#303030] flex items-center justify-between bg-[#141414]">
                    <div className="flex items-center gap-3 pr-4 overflow-hidden">
                        <FileText className="w-5 h-5 text-gray-400 shrink-0" />
                        <h2 className="text-xl font-bold text-white truncate">{title}</h2>
                        <span className="text-xs text-gray-400">{biography.handle}</span>
                    </div>
                     <div className="flex items-center gap-2">
                         {onEdit && allowEditBio !== false && (
                             <button onClick={onEdit} className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 cursor-pointer">
                                 Edit {labels.aliasBiographyItem}
                             </button>
                         )}
                         <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors cursor-pointer">
                             <X className="w-5 h-5" />
                         </button>
                     </div>
                </div>

                  <div className="flex-1 flex flex-col lg:flex-row min-h-0">
                      {/* Main Content: Bio */}
                       <div className="flex-1 border-b lg:border-b-0 lg:border-r border-[#272727] overflow-y-auto p-6">
                           <h3 className="text-lg font-bold text-white mb-4">About</h3>
                           {/* Font size/markdown look-and-feel kept in parity with the video Summary panel
                               (prose-sm — see Sidebar.tsx) rather than the previous prose-lg, which read
                               oversized next to it. */}
                           <div className="leading-relaxed prose dark:prose-invert prose-sm max-w-none prose-pre:bg-black/50 prose-code:text-red-400">
                               <ReactMarkdown
                                   remarkPlugins={[remarkGfm, remarkHighlight]}
 urlTransform={markdownUrlTransform}
                                   components={{
                                       a: MarkdownLink,
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

                       {/* Sidebar Content: Latest Videos — kept narrower than the About panel gets wide
                           (was w-96) so About has more horizontal room for markdown text. */}
                       <div className="w-full lg:w-80 bg-[#0f0f0f] flex flex-col p-6 space-y-4 overflow-y-auto">
                          <div className="flex items-center justify-between mb-4 shrink-0">
                              <h3 className="text-lg font-bold text-white">Latest Videos</h3>
                             {videos.length > 0 && (
                                 <button
                                     onClick={() => {
                                         onViewMore?.(biography.handle);
                                         onClose();
                                     }}
                                      className="text-xs font-semibold text-blue-400 hover:text-blue-300 transition-colors cursor-pointer p-1"
                                 >
                                     View More
                                 </button>
                             )}
                         </div>

                         {loadingVideos ? (
                             <div className="flex items-center justify-center py-8">
                                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                             </div>
                         ) : videos.length === 0 ? (
                              <div className="text-center text-gray-500 py-8">
                                 <p>No videos found for this channel</p>
                             </div>
                         ) : (
                             <div className="space-y-3 shrink-0">
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
                                          <h4 className="text-sm text-white leading-tight flex-1">{video.title}</h4>
                                     </div>
                                 ))}
                             </div>
                         )}

                         {drives.length > 0 && (
                             <div className="pt-4 border-t border-[#272727] flex flex-col lg:flex-1 lg:min-h-[10rem]">
                                 <h3 className="text-lg font-bold text-white mb-3 shrink-0">In {labels.aliasDriveName}</h3>
                                 <ul className="space-y-1 overflow-y-auto max-h-64 lg:max-h-none lg:flex-1 lg:min-h-0 pr-1">
                                     {drives.map((drive) => {
                                         // Hovering shows the Drive's alias (falling back to its path when it has none).
                                         const tooltip = drive.alias ?? drive.display;
                                         const content = (
                                             <>
                                                 <span className="text-gray-200 truncate">{drive.display}</span>
                                                 <span className="text-xs text-gray-500 shrink-0">{drive.count} video{drive.count === 1 ? '' : 's'}</span>
                                             </>
                                         );
                                         return (
                                             <li key={drive.path}>
                                                 {onDriveSelect ? (
                                                     <button
                                                         onClick={() => onDriveSelect(drive.path, driveSegmentLabel(drive.display))}
                                                         className="w-full flex items-center justify-between gap-3 text-sm text-left px-2 py-1.5 rounded-lg hover:bg-[#272727] transition-colors cursor-pointer"
                                                         title={tooltip}
                                                     >
                                                         {content}
                                                     </button>
                                                 ) : (
                                                     <div className="flex items-center justify-between gap-3 text-sm px-2 py-1.5" title={tooltip}>{content}</div>
                                                 )}
                                             </li>
                                         );
                                     })}
                                 </ul>
                             </div>
                         )}
                     </div>
                </div>

                {/* Sticky Footer: Social Icons — kept small and low-emphasis so the bio itself is
                    the thing that draws the eye, not the row of links below it. */}
                {activeSocials.length > 0 && (
                    <div className="flex-shrink-0 border-t border-[#272727] bg-[#0f0f0f] px-6 py-2">
                        <div className="flex flex-wrap gap-1.5">
                            {activeSocials.map((key) => {
                                const config = socialConfig[key];
                                const Icon = config.icon;
                                const rawValue = getSocialValue(biography, key);
                                return (
                                     <button
                                         key={key}
                                         onClick={() => openExternalUrl(rawValue)}
                                         title={config.label}
                                         className="flex items-center justify-center w-7 h-7 rounded-md bg-[#1b1b1b] border border-[#333] text-gray-400 hover:text-white hover:bg-[#262626] hover:border-blue-600/50 transition-all cursor-pointer"
                                     >
                                        <Icon className="w-3.5 h-3.5" />
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
