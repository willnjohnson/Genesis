import KinesisLogo from './assets/kinesis.png';
import GenesisLogo from './assets/genesis.png';

export type Brand = 'kinesis' | 'genesis';

// Default to Kinesis unless specified in env
const BRANDING_ID = (import.meta.env.VITE_BRANDING as Brand) || 'kinesis';

interface BrandConfig {
    id: Brand;
    name: string;
    tagline: string;
    logo: string;
    repo: string;
    dbName: string;
    storageKey: string;
    // UI-facing label for the saved-videos section (internal code/types keep calling this
    // "Library" regardless — see hooks/useLibrary.ts — this only renames what the user sees).
    // Kinesis demos as "Portal" (see the Library -> Portal enhancement doc) to gauge user
    // reaction to the Warp Drive-aligned framing; Genesis keeps the plainer "Library".
    libraryLabel: string;
    // UI-facing label for the WDBS taxonomy tree browser (see components/WdbsTreePanel.tsx,
    // toggled from the Library/Portal grid via App.tsx's Drive panel button) — a category-based
    // way to browse saved videos alongside the grid's flat/search view. "Warp Drive" for Kinesis
    // matches the Metabolic Warp Drive branding; Genesis keeps the plainer "Drive".
    driveLabel: string;
}

const BRANDS: Record<Brand, BrandConfig> = {
    genesis: {
        id: 'genesis',
        name: 'Genesis',
        tagline: 'YouTube Transcript Manager',
        logo: GenesisLogo,
        repo: 'https://github.com/willnjohnson/genesis',
        dbName: 'genesis_data.db',
        storageKey: 'genesis_db_path',
        libraryLabel: 'Library',
        driveLabel: 'Drive'
    },
    kinesis: {
        id: 'kinesis',
        name: 'Kinesis',
        tagline: 'Metabolic Warp Drive',
        logo: KinesisLogo,
        repo: 'https://github.com/willnjohnson/kinesis',
        dbName: 'kinesis_data.db',
        storageKey: 'kinesis_db_path',
        libraryLabel: 'Portal',
        driveLabel: 'Warp Drive'
    }
};

export const BRAND = BRANDS[BRANDING_ID];
