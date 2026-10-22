import { Schema } from 'effect';

export const SurfaceKind = Schema.Literals(['terminal', 'browser', 'markdown', 'file', 'other']);

export type SurfaceKind = typeof SurfaceKind.Type;

export const Surface = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  kind: SurfaceKind,
  focused: Schema.Boolean,
  pi: Schema.NullOr(Schema.Struct({ sessionId: Schema.String, status: Schema.String })),
  filePath: Schema.optional(Schema.NullOr(Schema.String)),
});

export type Surface = typeof Surface.Type;

export const Workspace = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  pinned: Schema.Boolean,
  color: Schema.NullOr(Schema.String),
  unread: Schema.Boolean,
  selected: Schema.Boolean,
  preview: Schema.NullOr(Schema.String),
  lastActivityAt: Schema.NullOr(Schema.Number),
  cwd: Schema.NullOr(Schema.String),
  groupId: Schema.NullOr(Schema.String),
  surfaces: Schema.Array(Surface),
});

export type Workspace = typeof Workspace.Type;

export const Group = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  pinned: Schema.Boolean,
  collapsed: Schema.Boolean,
  icon: Schema.NullOr(Schema.String),
  members: Schema.Array(Schema.String),
});

export type Group = typeof Group.Type;

export const Sidebar = Schema.Struct({
  at: Schema.Number,
  groups: Schema.Array(Group),
  workspaces: Schema.Array(Workspace),
});

export type Sidebar = typeof Sidebar.Type;

export const PiEntry = Schema.Struct({
  id: Schema.String,
  role: Schema.String,
  text: Schema.String,
  tool: Schema.NullOr(Schema.String),
  at: Schema.NullOr(Schema.String),
});

export type PiEntry = typeof PiEntry.Type;

export const PanelFrame = Schema.Union([
  Schema.TaggedStruct('Pi', { surfaceId: Schema.String, sessionId: Schema.String, status: Schema.String, entries: Schema.Array(PiEntry), reset: Schema.Boolean }),
  Schema.TaggedStruct('Text', { surfaceId: Schema.String, text: Schema.String }),
  Schema.TaggedStruct('Gone', { surfaceId: Schema.String, reason: Schema.String }),
  Schema.TaggedStruct('File', { surfaceId: Schema.String, name: Schema.String, mime: Schema.String, size: Schema.Number, mediaUrl: Schema.String }),
  Schema.TaggedStruct('Unsupported', { surfaceId: Schema.String, reason: Schema.String }),
  Schema.TaggedStruct('Screen', { surfaceId: Schema.String, image: Schema.String, width: Schema.Number, height: Schema.Number, url: Schema.String, title: Schema.String, at: Schema.Number }),
]);

export type PanelFrame = typeof PanelFrame.Type;

export const AllowedKey = Schema.Literals(['Escape', 'Enter', 'Tab', 'ctrl+c', 'Up', 'Down']);

export type AllowedKey = typeof AllowedKey.Type;

export const BrowserInput = Schema.Union([
  Schema.TaggedStruct('Tap', { x: Schema.Number, y: Schema.Number }),
  Schema.TaggedStruct('Scroll', { dx: Schema.Number, dy: Schema.Number }),
  Schema.TaggedStruct('Type', { text: Schema.String }),
  Schema.TaggedStruct('Press', { key: Schema.Literals(['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) }),
  Schema.TaggedStruct('Navigate', { url: Schema.String }),
  Schema.TaggedStruct('Back', {}),
  Schema.TaggedStruct('Forward', {}),
  Schema.TaggedStruct('Reload', {}),
]);

export type BrowserInput = typeof BrowserInput.Type;

export const Viewport = Schema.Struct({ width: Schema.Number, height: Schema.Number });

export type Viewport = typeof Viewport.Type;

export const SurfaceViewport = Schema.Struct({ surfaceId: Schema.String, width: Schema.Number, height: Schema.Number });

export const DaemonToRelay = Schema.Union([
  Schema.TaggedStruct('Hello', { machine: Schema.String, version: Schema.String }),
  Schema.TaggedStruct('Sidebar', { sidebar: Sidebar }),
  Schema.TaggedStruct('Frame', { frame: PanelFrame }),
  Schema.TaggedStruct('Sent', { requestId: Schema.String, ok: Schema.Boolean, reason: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct('MediaChunk', { requestId: Schema.String, ok: Schema.Boolean, start: Schema.Number, end: Schema.Number, total: Schema.Number, mime: Schema.String, data: Schema.String }),
]);

export type DaemonToRelay = typeof DaemonToRelay.Type;

export const RelayToDaemon = Schema.Union([
  Schema.TaggedStruct('Focus', { surfaceId: Schema.String }),
  Schema.TaggedStruct('Watch', { surfaceIds: Schema.Array(Schema.String), refresh: Schema.optional(Schema.Array(Schema.String)), viewports: Schema.optional(Schema.Array(SurfaceViewport)) }),
  Schema.TaggedStruct('MediaRequest', { requestId: Schema.String, surfaceId: Schema.String, start: Schema.Number, end: Schema.NullOr(Schema.Number) }),
  Schema.TaggedStruct('Send', { requestId: Schema.String, surfaceId: Schema.String, text: Schema.String, submit: Schema.Boolean }),
  Schema.TaggedStruct('Key', { surfaceId: Schema.String, key: AllowedKey }),
  Schema.TaggedStruct('Browser', { surfaceId: Schema.String, input: BrowserInput }),
]);

export type RelayToDaemon = typeof RelayToDaemon.Type;

export const PublishedTrack = Schema.Struct({ sessionId: Schema.String, trackName: Schema.String, at: Schema.Number });

export type PublishedTrack = typeof PublishedTrack.Type;

export const RelayToPhone = Schema.Union([
  Schema.TaggedStruct('Tracks', { tracks: Schema.Record(Schema.String, PublishedTrack) }),
  Schema.TaggedStruct('Machine', { online: Schema.Boolean, machine: Schema.NullOr(Schema.String), seenAt: Schema.NullOr(Schema.Number) }),
  Schema.TaggedStruct('Sidebar', { sidebar: Sidebar }),
  Schema.TaggedStruct('Frame', { frame: PanelFrame }),
  Schema.TaggedStruct('Sent', { requestId: Schema.String, ok: Schema.Boolean, reason: Schema.NullOr(Schema.String) }),
]);

export type RelayToPhone = typeof RelayToPhone.Type;

export const PhoneToRelay = Schema.Union([
  Schema.TaggedStruct('Open', { surfaceId: Schema.NullOr(Schema.String), viewport: Schema.optional(Viewport) }),
  Schema.TaggedStruct('Send', { requestId: Schema.String, surfaceId: Schema.String, text: Schema.String, submit: Schema.Boolean }),
  Schema.TaggedStruct('Browser', { surfaceId: Schema.String, input: BrowserInput }),
]);

export type PhoneToRelay = typeof PhoneToRelay.Type;

export const DAEMON_PATH = '/daemon';
export const PHONE_PATH = '/phone';
export const SIDEBAR_PATH = '/api/sidebar';
export const SEND_PATH = '/api/send';
export const FRAME_PATH = '/api/frame';
export const KEY_PATH = '/api/key';
export const MEDIA_PATH = '/api/media';
export const MAX_MEDIA_CHUNK = 1024 * 1024;
export const MAX_SEND_LENGTH = 20_000;
