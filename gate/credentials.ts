import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type McpCredentials = { readonly clientId: string; readonly clientSecret: string };

const fromKeychain = (): McpCredentials | null => {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.config', 'porch', 'config.json'), 'utf8')) as { readonly mcpClientId?: string };

    if (!config.mcpClientId) return null;
    const clientSecret = execFileSync('security', ['find-generic-password', '-s', 'porch-mcp', '-a', config.mcpClientId, '-w'], { encoding: 'utf8' }).trim();

    return clientSecret ? { clientId: config.mcpClientId, clientSecret } : null;
  } catch {
    return null;
  }
};

export const mcpCredentials = (): McpCredentials | null => {
  const clientId = process.env.PORCH_MCP_CLIENT_ID;
  const clientSecret = process.env.PORCH_MCP_CLIENT_SECRET;

  return clientId && clientSecret ? { clientId, clientSecret } : fromKeychain();
};
