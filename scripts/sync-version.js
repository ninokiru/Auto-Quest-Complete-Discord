/**
 * sync-version.js
 *
 * Reads the canonical version from public/version.txt, strips any
 * pre-release suffix (e.g. -rc1, -beta2), and patches:
 *   - package.json           (npm "version" field)
 *   - src-tauri/Cargo.toml   (Cargo [package] version)
 *   - src-tauri/tauri.conf.json (Tauri "version" field)
 *   - Cargo.lock             (the lock entry for this crate)
 *
 * The lock file matters because CI builds with `cargo --locked`, which fails
 * outright when Cargo.toml and Cargo.lock disagree.
 *
 * This ensures the Windows PE binary's FILEVERSION / PRODUCTVERSION
 * and the Rust env!("CARGO_PKG_VERSION") always match the real release
 * version (minus pre-release tags).
 *
 * Run automatically via the "build:runner" script before every
 * tauri:dev / tauri:build invocation.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

// ── 1. Read canonical version ────────────────────────────────────────────────
const versionFile = resolve(rootDir, 'public', 'version.txt');
const rawVersion = readFileSync(versionFile, 'utf-8').trim();

if (!rawVersion) {
    console.error('❌ public/version.txt is empty');
    process.exit(1);
}

// Strip pre-release suffix: "0.9.0-rc2" → "0.9.0"
const semver = rawVersion.split('-')[0];

// Validate basic x.y.z shape
if (!/^\d+\.\d+\.\d+$/.test(semver)) {
    console.error(`❌ Invalid semver "${semver}" derived from "${rawVersion}"`);
    process.exit(1);
}

console.log(`🔄 Syncing version: ${rawVersion} → ${semver}`);

// ── 2. Patch every target file ───────────────────────────────────────────────
/**
 * Prepare one version patch and verify the target field really carries the new
 * version. A plain String.replace() is silent when its pattern stops matching
 * (renamed field, reordered file), which would ship a stale version number.
 * Nothing is written until every target validated, so a broken pattern can not
 * leave the tree half-synced.
 */
const patches = [];

function patch(label, path, pattern, replacement, readVersion) {
    const original = readFileSync(path, 'utf-8');
    const updated = original.replace(pattern, replacement);
    let actual;
    try {
        actual = readVersion(updated);
    } catch (error) {
        throw new Error(`${label}: patched file could not be re-read: ${error.message}`);
    }
    if (actual !== semver) {
        const reason = original === updated
            ? 'the version field was not matched, so nothing was patched'
            : `patched file reports ${JSON.stringify(actual)}`;
        throw new Error(`${label}: ${reason} (expected "${semver}")`);
    }
    patches.push({ label, path, original, updated });
}

try {
    patch(
        'package.json',
        resolve(rootDir, 'package.json'),
        /("version"\s*:\s*")[\d.]+(")/,
        `$1${semver}$2`,
        (content) => JSON.parse(content).version
    );

    patch(
        'src-tauri/Cargo.toml',
        resolve(rootDir, 'src-tauri', 'Cargo.toml'),
        /^(version\s*=\s*)"[^"]+"/m,
        `$1"${semver}"`,
        (content) => /^version\s*=\s*"([^"]+)"/m.exec(content)?.[1]
    );

    patch(
        'src-tauri/tauri.conf.json',
        resolve(rootDir, 'src-tauri', 'tauri.conf.json'),
        /("version"\s*:\s*")[\d.]+(")/,
        `$1${semver}$2`,
        (content) => JSON.parse(content).version
    );

    // Anchored on this crate's own `[[package]]` block so a dependency that
    // happens to be listed first is never the one rewritten. Windows runners check
    // this file out with CRLF, so the line break between the two fields is matched
    // as `\r?\n` rather than assumed.
    patch(
        'Cargo.lock',
        resolve(rootDir, 'Cargo.lock'),
        /(name = "auto-quest-complete-discord"\r?\nversion = ")[^"]+(")/,
        `$1${semver}$2`,
        (content) => /name = "auto-quest-complete-discord"\r?\nversion = "([^"]+)"/.exec(content)?.[1]
    );
} catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
}

// ── 3. Write the validated patches ───────────────────────────────────────────
for (const { label, path, original, updated } of patches) {
    if (updated !== original) {
        writeFileSync(path, updated);
    }
    console.log(`   ✅ ${label} → ${semver}`);
}

console.log('🎉 Version sync complete.');
