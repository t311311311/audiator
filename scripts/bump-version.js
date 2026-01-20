const fs = require('fs');
const path = require('path');

// Read package.json
const packagePath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

// Split version into parts
let [major, minor, patch] = packageJson.version.split('.').map(Number);

// Increment patch version with custom logic (after 99 goes to next even minor number)
patch++;
if (patch > 99) {
    patch = 0;
    // Increase minor by 2 to go from x.0.x to x.2.x, x.2.x to x.4.x, etc.
    minor += 2;
    // If minor exceeds 99, increment major
    if (minor > 99) {
        minor = 0;
        major++;
    }
}

// Format version with leading zeros if needed (for consistent display)
const newVersion = `${major}.${minor}.${String(patch).padStart(2, '0')}`;

// Update version in package.json
packageJson.version = newVersion;

// Write back to package.json
fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));

console.log(`Version bumped to ${newVersion}`);