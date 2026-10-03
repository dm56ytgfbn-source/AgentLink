import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function preferredDeviceName(platform = process.platform, hostname = os.hostname()): Promise<string> {
  if (platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('/usr/sbin/scutil', ['--get', 'ComputerName'], { timeout: 2000 });
      const name = stdout.trim();
      if (name && name.length <= 200) return name;
    } catch { /* Use the stable system hostname when ComputerName is unavailable. */ }
  }
  return hostname;
}
