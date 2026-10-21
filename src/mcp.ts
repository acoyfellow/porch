import { Schema } from 'effect';
import { AllowedKey, BrowserInput, MAX_SEND_LENGTH, type PanelFrame, type Sidebar } from '../shared/protocol';

export type RelayCall = (path: string, init?: RequestInit) => Promise<Response>;

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'porch', version: '0.1.0' };
const READ_WAIT_MS = 12_000;


type Content = { readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

type ToolResult = { readonly content: ReadonlyArray<Content>; readonly isError?: boolean };

type Tool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly run: (args: Record<string, unknown>, relay: RelayCall) => Promise<ToolResult>;
};

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) });

const json = (value: unknown): ToolResult => text(JSON.stringify(value, null, 2));

const stringArg = (args: Record<string, unknown>, name: string): string | null => {
  const value = args[name];

  return typeof value === 'string' && value.length > 0 ? value : null;
};

const SURFACE = { surfaceId: { type: 'string', description: 'Surface id from list_workspaces.' } };

const postJson = (relay: RelayCall, path: string, body: unknown) => relay(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const replyOf = async (response: Response): Promise<ToolResult> => {
  const body = (await response.json()) as { readonly ok?: boolean; readonly reason?: string | null };

  return body.ok ? text('ok') : text(body.reason ?? `failed with ${response.status}`, true);
};

const summarize = (sidebar: Sidebar) =>
  sidebar.workspaces.map((workspace) => ({
    id: workspace.id,
    title: workspace.title,
    pinned: workspace.pinned,
    unread: workspace.unread,
    cwd: workspace.cwd,
    surfaces: workspace.surfaces.map((surface) => ({ id: surface.id, title: surface.title, kind: surface.pi ? 'pi' : surface.kind, focused: surface.focused, piStatus: surface.pi?.status ?? null })),
  }));

const frameContent = (frame: PanelFrame): ToolResult => {
  switch (frame._tag) {
    case 'Text':
      return text(frame.text);
    case 'Gone':
    case 'Unsupported':
      return text(frame.reason, true);
    case 'File':
      return text(`${frame.name}\n${frame.mime}, ${frame.size} bytes\nstream: ${frame.mediaUrl}`);
    case 'Pi':
      return text(frame.entries.map((entry) => `[${entry.role}${entry.tool ? ` ${entry.tool}` : ''}] ${entry.text}`).join('\n\n') || '(no entries yet)');
    case 'Screen': {
      const [header, data = ''] = frame.image.split(',');
      const mimeType = /data:([^;]+)/u.exec(header ?? '')?.[1] ?? 'image/jpeg';

      return { content: [{ type: 'text', text: `${frame.title}\n${frame.url}\n${frame.width}x${frame.height}` }, { type: 'image', data, mimeType }] };
    }
  }
};

const TOOLS: ReadonlyArray<Tool> = [
  {
    name: 'list_workspaces',
    description: 'List cmux workspaces and their surfaces (terminals, Pi sessions, browsers) on the owner\'s Mac.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_args, relay) => {
      const sidebar = (await (await relay('/sidebar')).json()) as Sidebar | null;

      return sidebar ? json(summarize(sidebar)) : text('the Mac has not sent its sidebar yet', true);
    },
  },
  {
    name: 'read_surface',
    description: 'Read what a surface shows right now: terminal text, Pi transcript, or a browser screenshot image.',
    inputSchema: { type: 'object', properties: SURFACE, required: ['surfaceId'] },
    run: async (args, relay) => {
      const surfaceId = stringArg(args, 'surfaceId');

      if (!surfaceId) return text('surfaceId is required', true);
      const query = new URLSearchParams({ surface: surfaceId, wait: String(READ_WAIT_MS), after: String(Date.now() - 1500), sinceAction: '1' });
      const { frame } = (await (await relay(`/frame?${query}`)).json()) as { readonly frame: PanelFrame | null };

      return frame ? frameContent(frame) : text('no frame arrived from the Mac in time', true);
    },
  },
  {
    name: 'send_text',
    description: 'Type text into a terminal or Pi surface. submit=true presses Enter afterwards (default true).',
    inputSchema: { type: 'object', properties: { ...SURFACE, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['surfaceId', 'text'] },
    run: async (args, relay) => {
      const surfaceId = stringArg(args, 'surfaceId');
      const value = typeof args['text'] === 'string' ? args['text'] : null;

      if (!surfaceId || value === null || value.length > MAX_SEND_LENGTH) return text('surfaceId and text (at most 20000 chars) are required', true);

      return replyOf(await postJson(relay, '/send', { surfaceId, text: value, submit: args['submit'] !== false }));
    },
  },
  {
    name: 'send_key',
    description: 'Press one key in a terminal surface: Escape, Enter, Tab, ctrl+c, Up or Down.',
    inputSchema: { type: 'object', properties: { ...SURFACE, key: { type: 'string', enum: [...AllowedKey.literals] } }, required: ['surfaceId', 'key'] },
    run: async (args, relay) => {
      const surfaceId = stringArg(args, 'surfaceId');
      const key = Schema.decodeUnknownOption(AllowedKey)(args['key']);

      if (!surfaceId || key._tag === 'None') return text(`surfaceId and key (${AllowedKey.literals.join(', ')}) are required`, true);

      return replyOf(await postJson(relay, '/key', { surfaceId, key: key.value }));
    },
  },
  {
    name: 'browser_input',
    description: 'Drive a cmux browser surface. input is one of {_tag:"Navigate",url}, {_tag:"Tap",x,y} in page CSS pixels, {_tag:"Scroll",dx,dy}, {_tag:"Type",text}, {_tag:"Press",key}, {_tag:"Back"}, {_tag:"Forward"}, {_tag:"Reload"}.',
    inputSchema: { type: 'object', properties: { ...SURFACE, input: { type: 'object' } }, required: ['surfaceId', 'input'] },
    run: async (args, relay) => {
      const surfaceId = stringArg(args, 'surfaceId');
      const input = Schema.decodeUnknownOption(BrowserInput)(args['input']);

      if (!surfaceId || input._tag === 'None') return text('surfaceId and a valid input are required', true);

      return replyOf(await postJson(relay, '/browser', { surfaceId, input: input.value }));
    },
  },
];

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);

type RpcRequest = { readonly jsonrpc?: string; readonly id?: string | number | null; readonly method?: string; readonly params?: Record<string, unknown> };

const result = (id: RpcRequest['id'], value: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result: value });

const failure = (id: RpcRequest['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

const dispatch = async (request: RpcRequest, relay: RelayCall): Promise<unknown | null> => {
  const id = request.id;

  switch (request.method) {
    case 'initialize':
      return result(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const name = request.params?.['name'];
      const tool = TOOLS.find((each) => each.name === name);

      if (!tool) return failure(id, -32602, `unknown tool: ${String(name)}`);
      const args = (request.params?.['arguments'] ?? {}) as Record<string, unknown>;

      try {
        return result(id, await tool.run(args, relay));
      } catch (error) {
        return result(id, text(error instanceof Error ? error.message : 'tool failed', true));
      }
    }
    default:
      return request.method?.startsWith('notifications/') ? null : failure(id, -32601, `method not found: ${String(request.method)}`);
  }
};

export const handleMcp = async (request: Request, relay: RelayCall): Promise<Response> => {
  if (request.method === 'GET') return new Response('porch MCP: POST JSON-RPC here', { status: 405, headers: { allow: 'POST' } });

  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json(failure(null, -32700, 'parse error'), { status: 400 });
  }
  const batch = Array.isArray(body) ? (body as ReadonlyArray<RpcRequest>) : [body as RpcRequest];
  const replies = (await Promise.all(batch.map((each) => dispatch(each, relay)))).filter((reply) => reply !== null);

  if (replies.length === 0) return new Response(null, { status: 202 });

  return Response.json(Array.isArray(body) ? replies : replies[0]);
};
