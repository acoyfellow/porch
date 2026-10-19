import { Schema } from 'effect';
import { defineMessageUnion } from 'foldkit/message';
import { RelayToPhone } from '../../shared/protocol';

export const Message = defineMessageUnion({
  SocketOpened: {},
  SocketClosed: {},
  Received: { message: RelayToPhone },
  Ticked: { now: Schema.Number },
  NavigatedTo: { workspaceId: Schema.NullOr(Schema.String), surfaceId: Schema.NullOr(Schema.String) },
  ClickedWorkspace: { workspaceId: Schema.String },
  ClickedSurface: { workspaceId: Schema.String, surfaceId: Schema.String },
  ClickedBack: {},
  ToggledGroup: { groupId: Schema.String },
  UpdatedDraft: { value: Schema.String },
  SubmittedDraft: {},
  PressedStop: {},
  ClickedCopy: { text: Schema.String },
  SendFinished: { requestId: Schema.String, ok: Schema.Boolean, reason: Schema.NullOr(Schema.String) },
  ScrolledFeed: { atBottom: Schema.Boolean },
  ClickedJumpToLatest: {},
  ClickedReconnect: {},
  CompletedEffect: {},
});

export type Message = typeof Message.Type;
