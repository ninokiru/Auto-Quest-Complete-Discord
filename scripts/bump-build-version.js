/**
 * bump-build-version.js
 *
 * Advances the small-patch label in public/version.txt:
 *   0.0.5        → 0.0.5-L1.1
 *   0.0.5-L1.1   → 0.0.5-L2.1
 *
 * The label is stored as `-L<build>.<attempt>` because the in-app updater only
 * accepts tags made of [A-Za-z0-9._-]. The UI renders it as "0.0.5 L2#1".
 * Every bumped file triggers build-release.yml, which publishes its own release.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const versionFile = resolve(__dirname, '..', 'public', 'version.txt');
const current = readFileSync(versionFile, 'utf-8').trim();

const match = /^(\d+\.\d+\.\d+)(?:-L(\d+)\.(\d+))?$/.exec(current);
if (!match) {
    console.error(
        `❌ Cannot add a build label to "${current}". Expected "x.y.z" or ` +
        '"x.y.z-L<n>.<m>" (finish the current -rc release first).'
    );
    process.exit(1);
}

const next = `${match[1]}-L${Number(match[2] ?? 0) + 1}.1`;
const display = next.replace(/-L(\d+)\.(\d+)$/, ' L$1#$2');

writeFileSync(versionFile, `${next}\n`);
console.log(`🔖 Version: ${current} → ${next} (shown as v${display})`);
