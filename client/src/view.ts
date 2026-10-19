import { Option } from 'effect';
import type { Document, Html, HtmlBuilder } from 'foldkit/html';
import type { Group, PiEntry, Surface, Workspace } from '../../shared/protocol';
import { Message } from './message';
import type { Model, Outgoing } from './model';
import { pathOf } from './route';

type H = HtmlBuilder<Message>;

const NEAR_BOTTOM_PX = 48;

export const MAX_RECONNECTS = 6;

const isTouch = () => globalThis.matchMedia?.('(pointer: coarse)').matches === true;

const isNearBottom = (scrollTop: number): boolean => {
  const feed = document.getElementById('feed');

  return feed === null || feed.scrollHeight - scrollTop - feed.clientHeight < NEAR_BOTTOM_PX;
};

const ago = (now: number, seconds: number | null): string => {
  if (seconds === null) return '';
  const delta = Math.max(0, Math.round(now / 1000 - seconds));

  if (delta < 60) return 'now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;

  return `${Math.floor(delta / 86400)}d`;
};

const piBusy = (surface: Surface) => surface.pi !== null && surface.pi.status === 'running';

const workspaceBusy = (workspace: Workspace) => workspace.surfaces.some(piBusy);

const KIND_LABEL: Record<Surface['kind'], string> = { terminal: 'terminal', browser: 'browser', markdown: 'markdown', file: 'file', other: 'panel' };

const statusBar = (h: H, model: Model): Html => {
  const mac = model.machineOnline ? `${model.machine ?? 'Mac'} online` : model.machine ? `${model.machine} offline` : 'waiting for your Mac';
  const live = model.connection === 'online';

  return h.div(
    [h.Id('status'), h.Class('flex items-center gap-2 px-4 py-2 text-xs text-zinc-400 border-b border-zinc-800/80'), h.Role('status'), h.AriaLive('polite')],
    [
      h.span([h.Class(`inline-block size-2 rounded-full ${live && model.machineOnline ? 'bg-emerald-400' : live ? 'bg-amber-400' : 'bg-zinc-600'}`), h.AriaHidden(true)], []),
      h.span([h.DataAttribute('connection', model.connection)], [live ? mac : model.connection === 'connecting' ? 'Connecting…' : model.failures > MAX_RECONNECTS ? 'Could not reach porch. Stopped retrying.' : `Reconnecting… (attempt ${model.failures})`]),
      model.connection === 'offline'
        ? h.button([h.Id('reconnect'), h.Class('ml-auto rounded-md border border-zinc-700 px-2 py-1 text-zinc-200'), h.OnClick(Message.ClickedReconnect())], ['Reconnect'])
        : null,
    ],
  );
};

const account = (h: H, who: string): Html =>
  h.div(
    [h.Class('ml-auto flex items-center gap-2 pr-2 text-xs text-zinc-500')],
    [
      who ? h.span([h.Id('who'), h.Class('hidden max-w-40 truncate sm:inline'), h.Title(who)], [who]) : null,
      h.a([h.Id('sign-out'), h.Href('/cdn-cgi/access/logout'), h.Class('flex min-h-11 items-center rounded-lg px-3 text-zinc-300 active:bg-zinc-800'), h.Title(who ? `Signed in as ${who}` : 'Sign out')], ['Sign out']),
    ],
  );

const header = (h: H, title: string, back: boolean, who: string): Html =>
  h.header(
    [h.Class('sticky top-0 z-10 flex min-h-12 items-center gap-2 bg-[#0b0c0f]/95 px-2 backdrop-blur pt-[env(safe-area-inset-top)]')],
    [
      back
        ? h.button([h.Id('back'), h.Class('flex size-11 items-center justify-center rounded-lg text-xl text-zinc-300 active:bg-zinc-800'), h.AriaLabel('Back'), h.OnClick(Message.ClickedBack())], ['‹'])
        : h.span([h.Class('pl-3 font-mono text-sm font-semibold tracking-wide text-zinc-200')], ['porch']),
      h.h1([h.Class('truncate text-[15px] font-semibold text-zinc-100')], [back ? title : '']),
      account(h, who),
    ],
  );

const colorDot = (h: H, workspace: Workspace): Html =>
  h.span(
    [h.Class('mt-1.5 inline-block size-2.5 shrink-0 rounded-full'), h.Style({ backgroundColor: workspace.color ?? 'transparent', border: workspace.color ? 'none' : '1px solid #3f3f46' }), h.AriaHidden(true)],
    [],
  );

const workspaceRow = (h: H, model: Model, workspace: Workspace): Html =>
  h.li(
    [],
    [
      h.a(
        [
          h.Href(pathOf({ workspaceId: workspace.id, surfaceId: null })),
          h.DataAttribute('workspace', workspace.id),
          h.DataAttribute('unread', String(workspace.unread)),
          h.Class(`flex min-h-14 gap-3 rounded-xl px-3 py-2.5 active:bg-zinc-800/70 ${workspace.selected ? 'bg-zinc-900' : ''}`),
          h.OnClick(Message.ClickedWorkspace({ workspaceId: workspace.id }), { defaultAction: 'Prevent' }),
        ],
        [
          colorDot(h, workspace),
          h.div(
            [h.Class('min-w-0 flex-1')],
            [
              h.div(
                [h.Class('flex items-center gap-2')],
                [
                  h.span([h.Class(`truncate text-[15px] ${workspace.unread ? 'font-semibold text-white' : 'text-zinc-200'}`)], [workspace.title]),
                  workspace.pinned ? h.span([h.Class('text-[10px] text-zinc-500'), h.AriaLabel('pinned')], ['●']) : null,
                  workspaceBusy(workspace) ? h.span([h.Class('rounded bg-emerald-500/15 px-1.5 text-[10px] font-medium text-emerald-300'), h.DataAttribute('busy', 'true')], ['working']) : null,
                  h.span([h.Class('ml-auto shrink-0 text-xs text-zinc-500')], [ago(model.now, workspace.lastActivityAt)]),
                ],
              ),
              workspace.preview ? h.p([h.Class('mt-0.5 line-clamp-2 text-[13px] leading-snug text-zinc-400')], [workspace.preview]) : null,
            ],
          ),
          workspace.unread ? h.span([h.Class('mt-2 size-2 shrink-0 rounded-full bg-sky-400'), h.AriaLabel('unread')], []) : null,
        ],
      ),
    ],
  );

const groupBlock = (h: H, model: Model, group: Group, members: ReadonlyArray<Workspace>): Html => {
  const collapsed = model.collapsed.includes(group.id) ? !group.collapsed : group.collapsed;

  return h.li(
    [h.DataAttribute('group', group.id)],
    [
      h.button(
        [
          h.Class('flex min-h-11 w-full items-center gap-2 px-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500'),
          h.AriaExpanded(!collapsed),
          h.OnClick(Message.ToggledGroup({ groupId: group.id })),
        ],
        [h.span([h.AriaHidden(true)], [collapsed ? '▸' : '▾']), group.name, h.span([h.Class('text-zinc-600')], [String(members.length)])],
      ),
      collapsed ? null : h.ul([h.Class('pl-3')], members.map((workspace) => workspaceRow(h, model, workspace))),
    ],
  );
};

const cockpit = (h: H, model: Model): Html => {
  const sidebar = model.sidebar;

  if (!sidebar) return h.p([h.Class('p-6 text-sm text-zinc-400')], [model.machineOnline ? 'Loading your sidebar…' : 'Start the porch daemon on your Mac to see your cmux sidebar here.']);
  const byId = new Map(sidebar.workspaces.map((workspace) => [workspace.id, workspace]));
  const grouped = new Set(sidebar.groups.flatMap((group) => group.members));
  const items: Array<Html> = [];
  const placed = new Set<string>();

  for (const workspace of sidebar.workspaces) {
    if (!grouped.has(workspace.id)) {
      items.push(workspaceRow(h, model, workspace));
      continue;
    }
    const group = sidebar.groups.find((each) => each.members.includes(workspace.id));

    if (!group || placed.has(group.id)) continue;
    placed.add(group.id);
    items.push(groupBlock(h, model, group, group.members.flatMap((id) => byId.get(id) ?? [])));
  }

  return h.ul([h.Id('workspaces'), h.Class('px-1 pb-[env(safe-area-inset-bottom)]')], items);
};

const surfaceRow = (h: H, workspace: Workspace, surface: Surface): Html =>
  h.li(
    [],
    [
      h.a(
        [
          h.Href(pathOf({ workspaceId: workspace.id, surfaceId: surface.id })),
          h.DataAttribute('surface', surface.id),
          h.DataAttribute('kind', surface.pi ? 'pi' : surface.kind),
          h.Class('flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 active:bg-zinc-800/70'),
          h.OnClick(Message.ClickedSurface({ workspaceId: workspace.id, surfaceId: surface.id }), { defaultAction: 'Prevent' }),
        ],
        [
          h.span([h.Class('w-16 shrink-0 font-mono text-[11px] uppercase text-zinc-500')], [surface.pi ? 'pi' : KIND_LABEL[surface.kind]]),
          h.span([h.Class('min-w-0 flex-1 truncate text-[15px] text-zinc-200')], [surface.title || 'untitled']),
          piBusy(surface) ? h.span([h.Class('text-[10px] font-medium text-emerald-300')], ['working']) : null,
          surface.focused ? h.span([h.Class('text-[10px] text-zinc-500')], ['focused']) : null,
        ],
      ),
    ],
  );

const workspaceView = (h: H, workspace: Workspace): Html =>
  h.div(
    [],
    [
      workspace.cwd ? h.p([h.Class('truncate px-4 pb-2 font-mono text-xs text-zinc-500')], [workspace.cwd]) : null,
      h.ul([h.Id('surfaces'), h.Class('px-1')], workspace.surfaces.map((surface) => surfaceRow(h, workspace, surface))),
    ],
  );

const ROLE_STYLE: Record<string, string> = {
  user: 'ml-8 rounded-2xl rounded-br-md bg-sky-600/25 px-3 py-2 text-zinc-50',
  assistant: 'text-zinc-100',
  toolCall: 'font-mono text-[12px] text-amber-300/90',
  toolResult: 'font-mono text-[12px] text-zinc-500 line-clamp-6',
  notice: 'text-center text-xs text-zinc-500',
};

const COPYABLE = new Set(['user', 'assistant']);

const entryView = (h: H, entry: PiEntry): Html =>
  h.li(
    [h.DataAttribute('role', entry.role), h.DataAttribute('entry', entry.id), h.Class(`group relative whitespace-pre-wrap break-words text-[15px] leading-relaxed ${ROLE_STYLE[entry.role] ?? 'text-zinc-300'}`)],
    [
      entry.role === 'toolCall' ? `→ ${entry.tool ?? 'tool'} ${entry.text}` : entry.text,
      COPYABLE.has(entry.role)
        ? h.button(
            [h.Class('copy mt-1 block min-h-8 rounded-md px-2 text-xs text-zinc-500 active:bg-zinc-800'), h.AriaLabel('Copy message'), h.OnClick(Message.ClickedCopy({ text: entry.text }))],
            ['Copy'],
          )
        : null,
    ],
  );

const outgoingView = (h: H, outgoing: Outgoing): Html =>
  h.li(
    [h.DataAttribute('outgoing', outgoing.state), h.Class('ml-8 rounded-2xl rounded-br-md border border-sky-600/40 px-3 py-2 text-[15px] text-zinc-200')],
    [outgoing.text, h.div([h.Class('mt-1 text-[11px] text-zinc-500')], [outgoing.state === 'failed' ? `Not sent: ${outgoing.reason ?? 'unknown error'}` : outgoing.state === 'sending' ? 'Sending to your Mac…' : 'Delivered to your Mac'])],
  );

const panelBody = (h: H, model: Model): Html => {
  const panel = model.panel;

  switch (panel._tag) {
    case 'Waiting':
      return h.p([h.Class('p-6 text-sm text-zinc-400'), h.DataAttribute('panel', 'waiting')], [model.machineOnline ? 'Opening this panel on your Mac…' : 'Your Mac is offline. This panel will load when it reconnects.']);
    case 'Gone':
      return h.p([h.Class('p-6 text-sm text-zinc-400'), h.DataAttribute('panel', 'gone')], [panel.reason]);
    case 'Text':
      return h.pre([h.DataAttribute('panel', 'text'), h.Class('whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-snug text-zinc-200')], [panel.text]);
    case 'Pi':
      return h.ol(
        [h.DataAttribute('panel', 'pi'), h.Class('flex flex-col gap-4 p-4')],
        [...panel.entries.map((entry) => entryView(h, entry)), ...model.outgoing.filter((each) => each.state !== 'sent').map((each) => outgoingView(h, each))],
      );
  }
};

const composer = (h: H, model: Model): Html =>
  h.form(
    [h.Id('composer-form'), h.Class('flex items-end gap-2 border-t border-zinc-800 bg-[#0b0c0f] px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]'), h.OnSubmit(Message.SubmittedDraft())],
    [
      h.textarea(
        [
          h.Id('composer'),
          h.Class('max-h-40 min-h-11 flex-1 resize-none rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-base text-zinc-100 placeholder:text-zinc-500'),
          h.Placeholder(model.panel._tag === 'Pi' ? 'Message this Pi session' : 'Type into this terminal'),
          h.Value(model.draft),
          h.Rows(Math.min(6, Math.max(1, model.draft.split('\n').length))),
          h.OnInput((value) => Message.UpdatedDraft({ value })),
          h.OnKeyDownPreventDefault((key, modifiers) => {
            if (key === 'Escape') return Option.some(Message.PressedStop());

            if (key === 'Enter' && !modifiers.shiftKey && !isTouch()) return Option.some(Message.SubmittedDraft());

            return Option.none();
          }),
          h.AriaLabel('Message'),
          h.AriaDescribedBy('composer-hint'),
        ],
      ),
      h.span([h.Id('composer-hint'), h.Class('sr-only')], [isTouch() ? 'Send with the Send button. Esc stops the agent.' : 'Enter sends, Shift+Enter adds a line, Esc stops the agent.']),
      h.button([h.Id('stop'), h.Type('button'), h.Class('min-h-11 rounded-xl border border-zinc-700 px-3 text-[15px] text-zinc-200'), h.AriaLabel('Stop the agent (Esc)'), h.OnClick(Message.PressedStop())], ['Stop']),
      h.button([h.Id('send'), h.Type('submit'), h.Class('min-h-11 rounded-xl bg-sky-600 px-4 text-[15px] font-medium text-white disabled:opacity-40'), h.Disabled(!model.draft.trim())], ['Send']),
    ],
  );

const panelView = (h: H, model: Model): Html =>
  h.div(
    [h.Class('flex min-h-0 flex-1 flex-col')],
    [
      h.div([h.Id('feed'), h.Role('log'), h.AriaLive('polite'), h.Class('relative min-h-0 flex-1 overflow-y-auto overscroll-contain'), h.OnScroll((scrollTop) => Message.ScrolledFeed({ atBottom: isNearBottom(scrollTop) }))], [panelBody(h, model)]),
      model.followTail
        ? null
        : h.button([h.Id('jump-to-latest'), h.Class('absolute bottom-24 right-4 rounded-full border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200 shadow'), h.OnClick(Message.ClickedJumpToLatest())], ['Jump to latest']),
      model.panel._tag === 'Pi' || model.panel._tag === 'Text' ? composer(h, model) : null,
    ],
  );

const findWorkspace = (model: Model) => model.sidebar?.workspaces.find((workspace) => workspace.id === model.workspaceId) ?? null;

export const view = (model: Model, h: H): Document => {
  const workspace = findWorkspace(model);
  const surface = workspace?.surfaces.find((each) => each.id === model.surfaceId) ?? null;
  const title = surface ? surface.title || 'panel' : (workspace?.title ?? '');

  return {
    title: title ? `${title} · porch` : 'porch',
    body: h.div(
      [h.Class('relative mx-auto flex h-dvh max-w-2xl flex-col')],
      [
        header(h, title, model.workspaceId !== null, model.who),
        statusBar(h, model),
        model.surfaceId
          ? panelView(h, model)
          : h.main([h.Class('min-h-0 flex-1 overflow-y-auto overscroll-contain')], [workspace ? workspaceView(h, workspace) : model.workspaceId ? h.p([h.Class('p-6 text-sm text-zinc-400')], ['This workspace is not open on your Mac.']) : cockpit(h, model)]),
      ],
    ),
  };
};
