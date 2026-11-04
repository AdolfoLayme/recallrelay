import { spawn } from 'node:child_process';

const api = spawn(process.execPath, ['--watch', 'src/server.ts'], { stdio: 'inherit' });
const web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'web/vite.config.ts'], { stdio: 'inherit' });
function stop(): void { api.kill(); web.kill(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
api.on('exit', stop);
web.on('exit', stop);
