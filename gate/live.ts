import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const origin = process.argv[2] ?? 'https://pi.coey.dev';
const cookie = readFileSync('.real/cookie', 'utf8').trim();
const headers = { cookie: `CF_Authorization=${cookie}`, 'content-type': 'application/json' };
const cmux = (args: ReadonlyArray<string>) => execFileSync('cmux', [...args], { encoding: 'utf8', timeout: 15_000 });

type Workspace = { readonly id: string; readonly title: string; readonly pinned: boolean; readonly surfaces: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly pi: { readonly status: string } | null }> };

const results: Array<[string, boolean, string]> = [];

const sidebar = (await (await fetch(`${origin}/api/sidebar`, { headers })).json()) as { readonly workspaces: ReadonlyArray<Workspace> } | null;
const local = JSON.parse(cmux(['rpc', 'mobile.workspace.list', '{}'])) as { readonly workspaces: ReadonlyArray<{ readonly title: string; readonly is_pinned: boolean }> };
const remoteKey = (sidebar?.workspaces ?? []).map((workspace) => `${workspace.title}|${workspace.pinned}`);
const localKey = local.workspaces.map((workspace) => `${workspace.title}|${workspace.is_pinned}`);
results.push(['2 sidebar matches mobile.workspace.list', JSON.stringify(remoteKey) === JSON.stringify(localKey), `${remoteKey.length} remote vs ${localKey.length} local`]);

const target = process.env.PORCH_TEST_SURFACE;

if (target) {
  const nonce = `porch-${crypto.randomUUID().slice(0, 8)}`;
  const sent = (await (await fetch(`${origin}/api/send`, { method: 'POST', headers, body: JSON.stringify({ surfaceId: target, text: `echo ${nonce}`, submit: true }) })).json()) as { readonly ok: boolean };
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const screen = cmux(['read-screen', '--surface', target, '--lines', '40']);
  results.push(['3 phone input lands in the cmux surface', sent.ok && screen.includes(nonce), `nonce ${nonce}`]);
} else {
  results.push(['3 phone input lands in the cmux surface', false, 'set PORCH_TEST_SURFACE to a scratch terminal surface id']);
}

const running = sidebar?.workspaces.flatMap((workspace) => workspace.surfaces).find((surface) => surface.pi?.status === 'running');

if (running) {
  const opened = Date.now();
  let fresh = false;

  for (let attempt = 0; attempt < 12 && !fresh; attempt++) {
    const { frame } = (await (await fetch(`${origin}/api/frame?surface=${encodeURIComponent(running.id)}&wait=5000`, { headers })).json()) as { readonly frame: { readonly _tag: string; readonly entries?: ReadonlyArray<{ readonly at: string | null }> } | null };
    fresh = frame?._tag === 'Pi' && (frame.entries ?? []).some((entry) => entry.at !== null && Date.parse(entry.at) > opened);

    if (!fresh) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  results.push(['4 Pi stream has a message newer than the open', fresh, running.id]);
} else {
  results.push(['4 Pi stream has a message newer than the open', false, 'no running Pi panel']);
}

for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${detail})`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
