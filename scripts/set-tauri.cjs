const fs = require('fs');
const path = require('path');

const branding = process.env.TAURI_BRANDING || 'kinesis';
const configPath = path.join(__dirname, '..', 'src-tauri', 'tauri.conf.json');
const packagePath = path.join(__dirname, '..', 'package.json');
const stateFile = path.join(__dirname, '..', 'scripts', '.branding-state');

// Get version from environment variable
const version = process.env.TAURI_VERSION || null;

console.log(`Setting icons for branding: ${branding}`);

// Read current branding state
let lastBranding = null;
try {
  if (fs.existsSync(stateFile)) {
    lastBranding = fs.readFileSync(stateFile, 'utf-8').trim();
  }
} catch (err) {
  // Ignore
}

// Check if branding changed
const brandingChanged = lastBranding !== branding;

// Save current branding
fs.writeFileSync(stateFile, branding);

if (brandingChanged) {
  console.log(`Branding changed from ${lastBranding || 'none'} to ${branding}, will rebuild...`);
}

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

// Update the icon paths based on branding
const iconFolder = `icons-${branding}`;
config.bundle.icon = [
  `${iconFolder}/32x32.png`,
  `${iconFolder}/128x128.png`,
  `${iconFolder}/128x128@2x.png`,
  `${iconFolder}/icon.icns`,
  `${iconFolder}/icon.ico`
];

// Update productName and identifier based on branding
if (branding === 'genesis') {
  config.productName = 'Genesis';
  config.identifier = 'genesisapp';
} else {
  config.productName = 'Kinesis';
  config.identifier = 'kinesisapp';
}

// Write back to config file
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`Updated tauri.conf.json with ${branding} icons and title (v${currentVersion})`);

// Only clean target if branding changed
if (brandingChanged) {
  console.log('Cleaning target directory for fresh rebuild...');
  const targetPath = path.join(__dirname, '..', 'src-tauri', 'target');
  try {
    if (fs.existsSync(targetPath)) {
      const debugPath = path.join(targetPath, 'debug');
      if (fs.existsSync(debugPath)) {
        fs.rmSync(debugPath, { recursive: true, force: true });
        console.log('Cleaned debug directory');
      }
    }
  } catch (err) {
    console.log('Warning: Could not clean target directory:', err.message);
  }
} else {
  console.log('Branding unchanged, skipping clean (no full recompile needed)');
}
