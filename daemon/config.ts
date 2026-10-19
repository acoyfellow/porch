import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const CONFIG_PATH = process.env.PORCH_CONFIG ?? join(homedir(), '.config', 'porch', 'config.json');
export const KEYCHAIN_SERVICE = 'porch-daemon';

export type DaemonConfig = { readonly origin: string; readonly clientId: string; readonly clientSecret: string };

const keychainSecret = async (account: string): Promise<string | undefined> => {
  try {
    const { stdout } = await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], { encoding: 'utf8' });

    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
};

export const loadConfig = async (): Promise<DaemonConfig> => {
  const file = JSON.parse(await readFile(CONFIG_PATH, 'utf8').catch(() => '{}')) as { readonly origin?: string; readonly clientId?: string };
  const origin = process.env.PORCH_ORIGIN ?? file.origin;
  const clientId = process.env.PORCH_CLIENT_ID ?? file.clientId;
  const clientSecret = process.env.PORCH_CLIENT_SECRET ?? (clientId ? await keychainSecret(clientId) : undefined);

  if (!origin || !clientId || !clientSecret) throw new Error(`porch daemon is not set up: need origin and clientId in ${CONFIG_PATH} and the client secret in the macOS keychain (service ${KEYCHAIN_SERVICE}). Run: bun daemon/setup.ts`);

  return { origin, clientId, clientSecret };
};
