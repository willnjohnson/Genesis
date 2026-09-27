import KinesisLogo from './assets/kinesis.png';
import GenesisLogo from './assets/genesis.png';
import { LOGO_MARKS, type LogoMark } from './assets/logo-marks';

export type Brand = 'kinesis' | 'genesis';

// Default to Kinesis unless specified in env
const BRANDING_ID = (import.meta.env.VITE_BRANDING as Brand) || 'kinesis';

interface BrandConfig {
    id: Brand;
    name: string;
    logo: string;
    /** The same logo as vector paths (see assets/logo-marks.ts). */
    mark: LogoMark;
    repo: string;
    dbName: string;
    storageKey: string;
}

// Section names (Search, Library, Drive, ...) are not per-brand: they're the workspace's aliases,
// see lib/workspace.ts and the Workspace tab in Settings.
const BRANDS: Record<Brand, BrandConfig> = {
    genesis: {
        id: 'genesis',
        name: 'Genesis',
        logo: GenesisLogo,
        mark: LOGO_MARKS.genesis,
        repo: 'https://github.com/willnjohnson/genesis',
        dbName: 'genesis_data.db',
        storageKey: 'genesis_db_path'
    },
    kinesis: {
        id: 'kinesis',
        name: 'Kinesis',
        logo: KinesisLogo,
        mark: LOGO_MARKS.kinesis,
        repo: 'https://github.com/willnjohnson/kinesis',
        dbName: 'kinesis_data.db',
        storageKey: 'kinesis_db_path'
    }
};

export const BRAND = BRANDS[BRANDING_ID];
