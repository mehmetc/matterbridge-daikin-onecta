/**
 * Publish the package to npm and ALWAYS restore the development state afterwards.
 *
 * The publish pipeline intentionally mutates the working directory into the exact
 * shape that gets shipped (production build, devDependencies and scripts stripped
 * from package.json, dev packages and the matterbridge link pruned from
 * node_modules, shrinkwrap generated). The original template scripts only restored
 * that state when `npm publish` succeeded; any failure (not logged in, expired OTP,
 * version already published, network) left the tree broken with dozens of
 * "Cannot find module 'matterbridge'" errors. This wrapper restores unconditionally.
 *
 * Usage: node scripts/publish.mjs [latest|dev|edge]   (default: latest)
 */

import { execSync } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';

const tag = process.argv[2] ?? 'latest';
const run = (command) => execSync(command, { stdio: 'inherit' });

copyFileSync('package.json', 'package.json.backup');
let failed = false;
try {
  run('npm run prepublishOnly');
  run(`npm publish --tag ${tag}`);
} catch {
  failed = true;
  console.error(`\npublish.mjs: publish failed - restoring the development state anyway.\n`);
}
copyFileSync('package.json.backup', 'package.json');
rmSync('package.json.backup', { force: true });
rmSync('npm-shrinkwrap.json', { force: true });
run('npm run reset');
process.exit(failed ? 1 : 0);
