// The logo's shape as vector paths, traced from kinesis.png (a flat single-color silhouette), so it can be drawn
// inline in the theme's accent color (components/BrandLogo.tsx): nothing to load, nothing to blink after a reload.
// The PNG stays for where an image file is needed (saving the logo, exports, the tray).
export interface LogoMark { w: number; h: number; d: string }

export const KINESIS_MARK: LogoMark = {
    w: 800, h: 800,
    d: "M308 799.4C306.1 799.2 299.6 798.5 293.6 798C146.9 783.8 24.2 666 3.6 519.5C0.1 495.1 0 486.5 0 248.5C0 19.9 0.1 10.3 1.8 7.1C5.6 0.1 6 -0 48.5 0C86.4 0 98.6 0.6 119.5 3.6C222.6 18.1 316.2 85.2 363.8 178.7C383 216.4 393.8 253.1 398.4 295.5C399.6 307.1 399.8 293 399.9 159.5C400 -7.3 399.4 5.9 407.1 1.8C411.9 -0.8 787 -1.1 792.3 1.5C799.7 5.1 799.5 3.4 799.5 52C799.5 104.9 797.9 120.8 789.5 153.4C755.1 286.9 642.7 383.5 504.5 398.4C492.9 399.6 507 399.8 640.5 399.9C807.3 400 794.1 399.4 798.2 407.1C801.2 412.6 801 787.9 798 792.8C793.6 800 793.8 800 752.5 800C684.9 800 649.6 794.2 603.9 775.5C554.4 755.3 505.1 718.5 472.5 677.5C431.5 626.1 403.9 556.3 400.8 496.2C400.6 493.6 400.3 559.1 400 641.7L399.5 792L395.7 795.7L392 799.5L351.7 799.6C329.6 799.7 309.9 799.6 308 799.4Z",
};
