import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LinkError } from '../packages/protocol/index.js';
import { launch as launchWindows, run as runWindows } from './windows.js';

const execFileAsync = promisify(execFile);

// Node RPC is platform-neutral. Only this adapter chooses the local operating system.
export function runHost(
  command: string,
  cwd: string,
  environment: Record<string, string> = {},
  timeout = 30000,
  signal?: AbortSignal,
  onOutput?: (stream: string, text: string) => void,
) {
  if (process.platform === 'win32') return runWindows(command, cwd, environment, timeout, signal, undefined, onOutput);
  if (process.platform === 'darwin') return runWindows(command, cwd, environment, timeout, signal, '/bin/zsh', onOutput);
  throw new LinkError('FORBIDDEN', 'This operating system has no command adapter');
}

export async function launchHost(app: string, args: string[], cwd: string, signal?: AbortSignal) {
  if (process.platform === 'win32') return launchWindows(app, args, cwd, signal);
  if (process.platform !== 'darwin') throw new LinkError('FORBIDDEN', 'This operating system has no application adapter');
  try {
    await execFileAsync('/usr/bin/open', ['-a', app, ...(args.length ? ['--args', ...args] : [])], {
      cwd, signal, timeout: 30000, windowsHide: true,
    });
  } catch (error) {
    if (signal?.aborted) throw new LinkError('PROCESS_FAILED', 'Cancelled');
    throw new LinkError('PROCESS_FAILED', (error as Error).message);
  }
  return { launched: true, application: app };
}

export function defaultNodeCapabilities(platform = process.platform): string[] {
  if (platform === 'win32') return ['filesystem', 'shell', 'tasks', 'window', 'screen', 'apps'];
  if (platform === 'darwin') return ['filesystem', 'shell', 'tasks', 'apps'];
  return ['filesystem'];
}
