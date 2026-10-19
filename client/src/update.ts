import type { Command } from 'foldkit';
import type { PanelFrame, PiEntry, RelayToPhone } from '../../shared/protocol';
import { CopyText, FollowTail, JumpToLatest, newRequestId, OpenSurface, PushLocation, SaveDraft, SendKey, SendText } from './command';
import { storedDraft } from './draft';
import { Message } from './message';
import type { Model, Panel } from './model';

type Return = { readonly model: Model; readonly commands?: ReadonlyArray<Command.Command<Message, never, never>> };

const MAX_ENTRIES = 400;
const MAX_OUTGOING = 20;

const mergeEntries = (current: ReadonlyArray<PiEntry>, incoming: ReadonlyArray<PiEntry>): ReadonlyArray<PiEntry> => {
  const seen = new Set(current.map((entry) => entry.id));

  return [...current, ...incoming.filter((entry) => !seen.has(entry.id))].slice(-MAX_ENTRIES);
};

export const panelAfter = (panel: Panel, frame: PanelFrame): Panel => {
  switch (frame._tag) {
    case 'Pi':
      return { _tag: 'Pi', status: frame.status, entries: frame.reset || panel._tag !== 'Pi' ? frame.entries : mergeEntries(panel.entries, frame.entries) };
    case 'Text':
      return { _tag: 'Text', text: frame.text };
    case 'Gone':
      return { _tag: 'Gone', reason: frame.reason };
  }
};

const follow = (model: Model): Return['commands'] => (model.followTail ? [FollowTail()] : []);

const received = (model: Model, message: RelayToPhone): Return => {
  switch (message._tag) {
    case 'Machine':
      return { model: { ...model, machine: message.machine, machineOnline: message.online, machineSeenAt: message.seenAt } };
    case 'Sidebar':
      return { model: { ...model, sidebar: message.sidebar } };
    case 'Frame': {
      if (message.frame.surfaceId !== model.surfaceId) return { model };
      const next = { ...model, panel: panelAfter(model.panel, message.frame) };

      return { model: next, commands: follow(next) };
    }
    case 'Sent':
      return { model };
  }
};

const navigate = (model: Model, workspaceId: string | null, surfaceId: string | null, push: boolean): Return => {
  const changedSurface = surfaceId !== model.surfaceId;
  const next: Model = { ...model, workspaceId, surfaceId, panel: changedSurface ? { _tag: 'Waiting' } : model.panel, followTail: changedSurface ? true : model.followTail, draft: changedSurface ? storedDraft(surfaceId) : model.draft };
  const commands = [...(changedSurface ? [OpenSurface({ surfaceId })] : []), ...(push ? [PushLocation({ workspaceId, surfaceId })] : [])];

  return { model: next, commands };
};

const submit = (model: Model): Return => {
  const text = model.draft.trim();

  if (!text || !model.surfaceId) return { model };
  const requestId = newRequestId();
  const outgoing = [...model.outgoing, { requestId, text, state: 'sending' as const, reason: null }].slice(-MAX_OUTGOING);

  return { model: { ...model, draft: '', outgoing, followTail: true }, commands: [SendText({ requestId, surfaceId: model.surfaceId, text }), SaveDraft({ surfaceId: model.surfaceId, value: '' }), JumpToLatest()] };
};

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    SocketOpened: () => ({ model: { ...model, connection: 'online', failures: 0 } }),
    SocketClosed: () => ({ model: { ...model, connection: 'offline', socketEpoch: model.socketEpoch + 1, failures: model.failures + 1 } }),
    Received: ({ message: incoming }) => received(model, incoming),
    Ticked: ({ now }) => ({ model: { ...model, now } }),
    NavigatedTo: ({ workspaceId, surfaceId }) => navigate(model, workspaceId, surfaceId, false),
    ClickedWorkspace: ({ workspaceId }) => navigate(model, workspaceId, null, true),
    ClickedSurface: ({ workspaceId, surfaceId }) => navigate(model, workspaceId, surfaceId, true),
    ClickedBack: () => (model.surfaceId ? navigate(model, model.workspaceId, null, true) : navigate(model, null, null, true)),
    ToggledGroup: ({ groupId }) => ({
      model: { ...model, collapsed: model.collapsed.includes(groupId) ? model.collapsed.filter((id) => id !== groupId) : [...model.collapsed, groupId] },
    }),
    UpdatedDraft: ({ value }) => ({ model: { ...model, draft: value }, commands: model.surfaceId ? [SaveDraft({ surfaceId: model.surfaceId, value })] : [] }),
    ClickedCopy: ({ text }) => ({ model, commands: [CopyText({ text })] }),
    PressedStop: () => (model.surfaceId ? { model, commands: [SendKey({ surfaceId: model.surfaceId, key: 'Escape' })] } : { model }),
    SubmittedDraft: () => submit(model),
    SendFinished: ({ requestId, ok, reason }) => ({
      model: {
        ...model,
        outgoing: model.outgoing.map((each) => (each.requestId === requestId ? { ...each, state: ok ? ('sent' as const) : ('failed' as const), reason } : each)),
        draft: ok ? model.draft : model.draft || (model.outgoing.find((each) => each.requestId === requestId)?.text ?? ''),
      },
    }),
    ScrolledFeed: ({ atBottom }) => ({ model: { ...model, followTail: atBottom } }),
    ClickedJumpToLatest: () => ({ model: { ...model, followTail: true }, commands: [JumpToLatest()] }),
    ClickedReconnect: () => ({ model: { ...model, connection: 'connecting', socketEpoch: model.socketEpoch + 1, failures: 0 } }),
    CompletedEffect: () => ({ model }),
  });
