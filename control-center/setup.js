import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, loadConfig, loadSlots } from './backend/config.js';

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) { console.error('This Mindcraft version requires Node.js 22 or newer (Mineflayer 4.33). Install Node.js 22 LTS from https://nodejs.org, then run SETUP.bat again. Node 18/20 cannot run this release.'); process.exit(1); }
if (![18, 20, 22, 24].includes(major)) console.warn(`Node ${process.versions.node} is not an LTS release. Native Mineflayer/viewer dependencies may need an LTS runtime. See TECH_GPT_README.md.`);
for (const folder of ['data/runs', 'bots', 'profiles/arena']) fs.mkdirSync(path.join(ROOT, folder), { recursive: true });
for (const [template, target] of [['keys.example.json', 'keys.json'], ['arena.config.example.json', 'arena.config.json'], ['brain.config.example.json', 'brain.config.json']]) {
    const destination = path.join(ROOT, target);
    if (!fs.existsSync(destination)) { fs.copyFileSync(path.join(ROOT, template), destination, fs.constants.COPYFILE_EXCL); console.log(`Created ${target}.`); }
    else console.log(`Preserved your existing ${target}.`);
}
if (!process.argv.includes('--config-only')) {
    const runNpm = args => spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd ' + args.join(' ')] : args, { stdio: 'inherit', cwd: ROOT, windowsHide: true });
    const check = runNpm(['--version']);
    if (check.status !== 0) { console.error('npm is missing. Reinstall Node.js with npm enabled.'); process.exit(1); }
    const install = runNpm(['install', '--omit=optional', '--no-audit', '--no-fund']);
    if (install.status !== 0) { console.error('Dependency installation failed. See the error above and the Node/native dependency section in TECH_GPT_README.md. Your configuration was preserved.'); process.exit(1); }
    const smoke = spawnSync(process.execPath, ['control-center/check.js'], { stdio: 'inherit', cwd: ROOT, windowsHide: true });
    if (smoke.status !== 0) process.exit(1);
}
try {
    const slots = loadSlots(loadConfig());
    for (const slot of slots.filter(s => s.enabled)) console.log(`${slot.displayName}: ${slot.error || 'profile ready'}`);
    console.log('\nSetup succeeded. Add your API key to keys.json, open Minecraft to LAN on port 55916, then double-click START_TEST.bat.');
} catch (error) { console.error(error.message); process.exit(1); }
