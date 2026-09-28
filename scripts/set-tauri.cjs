const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'src-tauri', 'tauri.conf.json');
const packagePath = path.join(__dirname, '..', 'package.json');

// Get version from environment variable
const version = process.env.TAURI_VERSION || null;

// Read the config file
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// Read package.json
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));

// Default version from package.json if not provided via flag
const defaultVersion = packageJson.version || '0.2.1';
const currentVersion = version || defaultVersion;

// Update version in tauri.conf.json if provided
if (version) {
  config.version = version;
  console.log(`Updated tauri.conf.json version to ${version}`);
}

// Update version in package.json if provided
if (version && packageJson.version !== version) {
  packageJson.version = version;
  fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
  console.log(`Updated package.json version to ${version}`);
}

// Icon path, productName and identifier — Kinesis-only now (this used to switch between
// icons-kinesis/icons-genesis for a second, white-labeled build of this app; that build no longer
// exists, see git history if it's ever needed again).
config.bundle.icon = [
  'icons-kinesis/32x32.png',
  'icons-kinesis/128x128.png',
  'icons-kinesis/128x128@2x.png',
  'icons-kinesis/icon.icns',
  'icons-kinesis/icon.ico'
];
config.productName = 'Kinesis';
config.identifier = 'kinesisapp';

// Write back to config file
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`Updated tauri.conf.json (v${currentVersion})`);
