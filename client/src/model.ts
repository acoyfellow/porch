import { Schema } from 'effect';
import { PiEntry, Sidebar } from '../../shared/protocol';

export const Connection = Schema.Literals(['connecting', 'online', 'offline']);

export type Connection = typeof Connection.Type;

export const Panel = Schema.Union([
  Schema.TaggedStruct('Waiting', {}),
  Schema.TaggedStruct('Pi', { status: Schema.String, entries: Schema.Array(PiEntry) }),
  Schema.TaggedStruct('Text', { text: Schema.String }),
  Schema.TaggedStruct('Gone', { reason: Schema.String }),
  Schema.TaggedStruct('Screen', { image: Schema.String, width: Schema.Number, height: Schema.Number, url: Schema.String, title: Schema.String, at: Schema.Number }),
]);

export const Press = Schema.Struct({ screenX: Schema.Number, screenY: Schema.Number, pageX: Schema.Number, pageY: Schema.Number, scale: Schema.Number });

export type Press = typeof Press.Type;

export type Panel = typeof Panel.Type;

export const Outgoing = Schema.Struct({ requestId: Schema.String, text: Schema.String, state: Schema.Literals(['sending', 'sent', 'failed']), reason: Schema.NullOr(Schema.String) });

export type Outgoing = typeof Outgoing.Type;

export const Model = Schema.Struct({
  connection: Connection,
  socketEpoch: Schema.Number,
  failures: Schema.Number,
  machine: Schema.NullOr(Schema.String),
  machineOnline: Schema.Boolean,
  machineSeenAt: Schema.NullOr(Schema.Number),
  sidebar: Schema.NullOr(Sidebar),
  workspaceId: Schema.NullOr(Schema.String),
  surfaceId: Schema.NullOr(Schema.String),
  panel: Panel,
  draft: Schema.String,
  outgoing: Schema.Array(Outgoing),
  followTail: Schema.Boolean,
  collapsed: Schema.Array(Schema.String),
  now: Schema.Number,
  who: Schema.String,
  press: Schema.NullOr(Press),
  address: Schema.String,
  editingAddress: Schema.Boolean,
});

export type Model = typeof Model.Type;
