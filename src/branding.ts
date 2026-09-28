import KinesisLogo from './assets/kinesis.png';
import { KINESIS_MARK, type LogoMark } from './assets/logo-marks';

interface BrandConfig {
    name: string;
    logo: string;
    /** The same logo as vector paths (see assets/logo-marks.ts). */
    mark: LogoMark;
}

export const BRAND: BrandConfig = {
    name: 'Kinesis',
    logo: KinesisLogo,
    mark: KINESIS_MARK,
};
