import { execFileSync } from 'node:child_process';

const origin = process.argv[2] ?? 'http://127.0.0.1:8790';
const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)/u.test(origin);
const clientId = process.env.PORCH_MCP_CLIENT_ID;
const clientSecret = process.env.PORCH_MCP_CLIENT_SECRET;

if (!isLocal && (!clientId || !clientSecret)) throw new Error('set PORCH_MCP_CLIENT_ID and PORCH_MCP_CLIENT_SECRET to test a deployed origin');

const authHeaders: Record<string, string> = isLocal ? { 'x-porch-dev-caller': 'mcp' } : { 'cf-access-client-id': clientId ?? '', 'cf-access-client-secret': clientSecret ?? '' };

const cmux = (args: ReadonlyArray<string>) => execFileSync('cmux', [...args], { encoding: 'utf8', timeout: 15_000 });

type Content = { readonly type: string; readonly text?: string; readonly data?: string };

type CallResult = { readonly content: ReadonlyArray<Content>; readonly isError?: boolean };

let nextId = 1;

const rpc = async (method: string, params: Record<string, unknown> = {}, headers = authHeaders) => {
  const response = await fetch(`${origin}/mcp`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }) });

  return { status: response.status, body: response.status === 200 ? ((await response.json()) as { result?: unknown; error?: { message: string } }) : null };
};

const call = async (name: string, args: Record<string, unknown>): Promise<CallResult> => {
  const { body } = await rpc('tools/call', { name, arguments: args });

  if (!body?.result) throw new Error(`${name}: ${body?.error?.message ?? 'no result'}`);

  return body.result as CallResult;
};

const textOf = (result: CallResult) => result.content.flatMap((part) => (part.text ? [part.text] : [])).join('\n');

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail: string) => results.push([name, ok, detail]);

const stranger = await rpc('initialize', {}, isLocal ? { 'x-porch-dev-caller': 'stranger' } : {});
check('refuses callers without the MCP token', stranger.status === 403 || stranger.status === 302 || stranger.status === 401, `status ${stranger.status}`);

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'porch-gate', version: '0' } });
const serverName = (init.body?.result as { serverInfo?: { name?: string } } | undefined)?.serverInfo?.name;
check('initialize', serverName === 'porch', `server ${serverName ?? init.status}`);

const listed = await rpc('tools/list');
const names = ((listed.body?.result as { tools?: ReadonlyArray<{ name: string }> } | undefined)?.tools ?? []).map((tool) => tool.name);
check('tools/list has 5 tools', names.length === 5, names.join(', '));

type Listed = ReadonlyArray<{ readonly id: string; readonly title: string; readonly surfaces: ReadonlyArray<{ readonly id: string; readonly kind: string }> }>;

const workspaces = JSON.parse(textOf(await call('list_workspaces', {}))) as Listed;
const local = JSON.parse(cmux(['rpc', 'mobile.workspace.list', '{}'])) as { readonly workspaces: ReadonlyArray<{ readonly title: string }> };
check('list_workspaces matches cmux', JSON.stringify(workspaces.map((each) => each.title)) === JSON.stringify(local.workspaces.map((each) => each.title)), `${workspaces.length} vs ${local.workspaces.length}`);

const scratch = /OK ([0-9A-F-]{36}) ([0-9A-F-]{36}) ([0-9A-F-]{36})/u;
const terminal = scratch.exec(cmux(['new-surface', '--type', 'terminal', '--focus', 'false', '--id-format', 'uuids']))?.[1];
const browser = scratch.exec(cmux(['new-surface', '--type', 'browser', '--url', 'https://example.com', '--focus', 'false', '--id-format', 'uuids']))?.[1];

try {
  await new Promise((resolve) => setTimeout(resolve, 5000));

  if (terminal) {
    const nonce = `porch-mcp-${crypto.randomUUID().slice(0, 8)}`;
    const sent = await call('send_text', { surfaceId: terminal, text: `echo ${nonce}` });
    let screen = '';

    for (let attempt = 0; attempt < 16 && screen.split(nonce).length <= 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      screen = cmux(['read-screen', '--surface', terminal, '--lines', '20']);
    }
    check('send_text lands in a cmux terminal', !sent.isError && screen.split(nonce).length > 2, nonce);
    const read = textOf(await call('read_surface', { surfaceId: terminal }));
    check('read_surface returns terminal text', read.includes(nonce), `${read.length} chars`);
  } else {
    check('send_text lands in a cmux terminal', false, 'could not create a scratch terminal');
  }

  if (browser) {
    const shot = await call('read_surface', { surfaceId: browser });
    const image = shot.content.find((part) => part.type === 'image');
    check('read_surface returns a browser image', (image?.data?.length ?? 0) > 1000, `${image?.data?.length ?? 0} base64 chars`);
    const target = 'https://www.iana.org/help/example-domains';
    const moved = await call('browser_input', { surfaceId: browser, input: { _tag: 'Navigate', url: target } });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const url = (JSON.parse(cmux(['rpc', 'browser.url.get', JSON.stringify({ surface_id: browser })])) as { url?: string }).url ?? '';
    check('browser_input navigates the real cmux browser', !moved.isError && url.startsWith(target), url);
  } else {
    check('read_surface returns a browser image', false, 'could not create a scratch browser');
  }
} finally {
  for (const surface of [terminal, browser]) if (surface) cmux(['close-surface', '--surface', surface]);
}

for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${detail})`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
