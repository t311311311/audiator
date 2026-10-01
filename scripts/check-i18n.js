// Checks the interface translations (AUD-33).
//
//   node scripts/check-i18n.js
//
// Fails (exit 1) if a page uses a key the dictionary does not have — that would
// show the raw key, e.g. "settings.theem", to the user — or if a language is
// missing keys English has. Also reports keys nobody uses, and checks that the
// inline <script> blocks still parse.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const i18n = require(path.join(SRC, 'i18n.js'));

const files = fs.readdirSync(SRC).filter((f) => /\.(html|js)$/.test(f) && f !== 'i18n.js');
const patterns = [
  /data-i18n="([^"]+)"/g,
  /data-i18n-title="([^"]+)"/g,
  /\bS\('([^']+)'\)/g,
  /\btr\('([^']+)'\)/g,
  /strings\['([^']+)'\]/g,
];

const used = new Map(); // key -> [file, ...]
for (const f of files) {
  const text = fs.readFileSync(path.join(SRC, f), 'utf8');
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      if (!used.has(m[1])) used.set(m[1], new Set());
      used.get(m[1]).add(f);
    }
  }
}

let failed = false;
const en = Object.keys(i18n.STRINGS[i18n.FALLBACK]);

// 1. every used key exists
const missing = [...used.keys()].filter((k) => !en.includes(k)).sort();
if (missing.length) {
  failed = true;
  console.log('MISSING keys (would show the raw key to the user):');
  for (const k of missing) console.log(`  ${k}  <- ${[...used.get(k)].join(', ')}`);
}

// 2. every language has every key
for (const lang of Object.keys(i18n.LANGUAGES)) {
  const keys = Object.keys(i18n.STRINGS[lang] || {});
  const gap = en.filter((k) => !keys.includes(k));
  if (gap.length) {
    failed = true;
    console.log(`Language "${lang}" is missing: ${gap.join(', ')}`);
  }
}

// 3. keys nobody uses (not an error, just clutter to prune)
const unused = en.filter((k) => !used.has(k));
if (unused.length) console.log(`Unused keys (${unused.length}): ${unused.join(', ')}`);

// 4. inline scripts still parse
for (const f of files.filter((x) => x.endsWith('.html'))) {
  const text = fs.readFileSync(path.join(SRC, f), 'utf8');
  const blocks = [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  blocks.forEach((b, i) => {
    try { new vm.Script(b[1], { filename: `${f}#script${i + 1}` }); }
    catch (e) { failed = true; console.log(`SYNTAX ${f} script ${i + 1}: ${e.message}`); }
  });
}

console.log(`\nkeys in dictionary: ${en.length}, used by pages: ${used.size}, ` +
            `languages: ${Object.keys(i18n.LANGUAGES).join('/')}`);
console.log(failed ? 'FAIL' : 'OK');
process.exit(failed ? 1 : 0);
