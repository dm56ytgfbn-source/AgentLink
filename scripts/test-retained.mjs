import { spawnSync } from 'node:child_process';
const names = ['health', 'audit', 'config', 'selfsigned', 'discovery', 'ui', 'layout-live', 'windows-package', 'agent-install', 'status', 'install', 'task-journal', 'cli-large-file', 'upload-residue', 'secrets', 'pairing', 'pairing-auto', 'trust', 'trust-signed-requests', 'tasks-retained', 'files-retained', 'https-retained', 'webdav-retained', 'webdav-lock-guard', 'reconnect-retained', 'reconnect-auto', 'input-share'];
const result = spawnSync(process.execPath, ['--test', ...names.map(name => `dist/tests/${name}.test.js`)], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
