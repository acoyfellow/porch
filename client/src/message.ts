import { Schema } from 'effect';
import { defineMessageUnion } from 'foldkit/message';
import { BrowserInput, RelayToPhone } from '../../shared/protocol';

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
  PressedScreen: { screenX: Schema.Number, screenY: Schema.Number, pageX: Schema.Number, pageY: Schema.Number, scale: Schema.Number },
  ReleasedScreen: { screenX: Schema.Number, screenY: Schema.Number },
  SentBrowser: { input: BrowserInput },
  UpdatedAddress: { value: Schema.String },
  FocusedAddress: {},
  SubmittedAddress: {},
});

export type Message = typeof Message.Type;
