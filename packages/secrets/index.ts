import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {promisify} from 'node:util';

// Credentials must not live in a world-readable-by-accident JSON file. This module is the
// only place that knows how a pairing secret is stored, so the rest of the product can ask
// for a token without caring whether it comes from the keychain or a legacy config file.

const exec = promisify(execFile);
export const SECRET_SERVICE = 'AgentLink';

export interface SecretStore {
  readonly kind: string;
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  remove(account: string): Promise<void>;
}

export interface KeychainOptions { keychain?: string; service?: string; security?: string }

export function macKeychainStore(options: KeychainOptions = {}): SecretStore {
  const security = options.security ?? '/usr/bin/security';
  const service = options.service ?? SECRET_SERVICE;
  // security takes the keychain as a trailing positional argument, not as a flag.
  const keychain = options.keychain ? [options.keychain] : [];
  return {
    kind: options.keychain ? 'keychain:' + options.keychain : 'keychain:default',
    async get(account) {
      try {
        const { stdout } = await exec(security, ['find-generic-password', '-a', account, '-s', service, '-w', ...keychain], { timeout: 8000 });
        const value = stdout.replace(/\r?\n$/, '');
        return value || null;
      } catch { return null; }
    },
    async set(account, value) {
      await exec(security, ['add-generic-password', '-U', '-a', account, '-s', service, '-w', value, ...keychain], { timeout: 8000 });
    },
    async remove(account) {
      await exec(security, ['delete-generic-password', '-a', account, '-s', service, ...keychain], { timeout: 8000 }).catch(() => {});
    },
  };
}

// Windows would use DPAPI/credential manager here; until that exists the product keeps the
// documented fallback (file with 0600) instead of pretending a secret is protected.
export async function defaultSecretStore(options: KeychainOptions = {}): Promise<SecretStore | null> {
  if (process.platform !== 'darwin') return null;
  const security = options.security ?? '/usr/bin/security';
  return existsSync(security) ? macKeychainStore(options) : null;
}

export function secretStoreDescription(store: SecretStore | null) {
  return store ? store.kind : 'none (credentials stay in the configuration file with 0600)';
}
