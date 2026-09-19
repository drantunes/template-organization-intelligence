import { spawnSync } from 'node:child_process';

const install = spawnSync('pnpm', ['install', '--frozen-lockfile'], { stdio: 'inherit' });
if (install.status !== 0) process.exit(install.status ?? 1);

const start = spawnSync('pnpm', ['dev'], { stdio: 'inherit' });
process.exit(start.status ?? 1);
