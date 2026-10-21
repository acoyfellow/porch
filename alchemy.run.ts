import * as Alchemy from 'alchemy';
import * as Cloudflare from 'alchemy/Cloudflare';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import type { Relay } from './src/relay.ts';

const COMPATIBILITY_DATE = '2026-10-01';

export default Alchemy.Stack(
  'porch',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const domain = yield* Config.String('PORCH_DOMAIN');
    const owner = yield* Config.String('PORCH_OWNER_EMAIL');
    const team = yield* Config.String('PORCH_ACCESS_TEAM');

    const daemonToken = yield* Cloudflare.Access.ServiceToken('daemon-token', { name: `porch daemon (${domain})`, duration: '8760h' });

    const mcpToken = yield* Cloudflare.Access.ServiceToken('mcp-token', { name: `porch mcp (${domain})`, duration: '8760h' });

    const app = yield* Cloudflare.Access.Application('access', {
      type: 'self_hosted',
      name: `porch (${domain})`,
      domain,
      sessionDuration: '720h',
      appLauncherVisible: false,
      policies: [
        { name: 'owner', decision: 'allow', include: [{ email: owner }] },
        { name: 'daemon', decision: 'non_identity', include: [{ serviceToken: daemonToken.serviceTokenId }] },
        { name: 'mcp', decision: 'non_identity', include: [{ serviceToken: mcpToken.serviceTokenId }] },
      ],
    });

    const worker = yield* Cloudflare.Worker('porch', {
      main: './src/index.ts',
      compatibility: { date: COMPATIBILITY_DATE },
      observability: { enabled: true },
      workersDev: false,
      domain,
      assets: { directory: './public', runWorkerFirst: true },
      env: {
        RELAY: Cloudflare.DurableObject<Relay>('Relay'),
        ACCESS_TEAM: team,
        ACCESS_AUD: app.aud,
        OWNER_EMAIL: owner,
        DAEMON_TOKEN_ID: daemonToken.clientId,
        MCP_TOKEN_ID: mcpToken.clientId,
      },
    });

    return { url: worker.url, aud: app.aud, daemonClientId: daemonToken.clientId, daemonClientSecret: daemonToken.clientSecret, mcpClientId: mcpToken.clientId, mcpClientSecret: mcpToken.clientSecret };
  }),
);
