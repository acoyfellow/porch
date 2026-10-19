import { Effect, Schema } from 'effect';
import { Command, Navigation } from 'foldkit';
import { SEND_PATH } from '../../shared/protocol';
import { Message } from './message';
import { pathOf } from './route';
import { openSurface } from './socket';

const SendReply = Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.NullOr(Schema.String)) });

export const SendText = Command.define('SendText', {
  args: { requestId: Schema.String, surfaceId: Schema.String, text: Schema.String },
  messages: [Message.SendFinished],
  execute: ({ requestId, surfaceId, text }) =>
    Effect.tryPromise(() =>
      fetch(SEND_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ surfaceId, text, submit: true }),
      }).then((response) => response.json()),
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SendReply)),
      Effect.map((reply) => Message.SendFinished({ requestId, ok: reply.ok, reason: reply.reason ?? null })),
      Effect.orElseSucceed(() => Message.SendFinished({ requestId, ok: false, reason: 'could not reach porch' })),
    ),
});

export const OpenSurface = Command.define('OpenSurface', {
  args: { surfaceId: Schema.NullOr(Schema.String) },
  messages: [Message.CompletedEffect],
  execute: ({ surfaceId }) => Effect.sync(() => openSurface(surfaceId)).pipe(Effect.as(Message.CompletedEffect())),
});

export const PushLocation = Command.define('PushLocation', {
  args: { workspaceId: Schema.NullOr(Schema.String), surfaceId: Schema.NullOr(Schema.String) },
  messages: [Message.CompletedEffect],
  execute: (location) => Navigation.pushUrl(pathOf(location)).pipe(Effect.as(Message.CompletedEffect())),
});

export const JumpToLatest = Command.define('JumpToLatest', {
  messages: [Message.CompletedEffect],
  execute: Effect.sync(() => {
    const feed = document.getElementById('feed');

    if (feed) feed.scrollTop = feed.scrollHeight;
  }).pipe(Effect.as(Message.CompletedEffect())),
});

export const FollowTail = Command.define('FollowTail', {
  messages: [Message.CompletedEffect],
  execute: Effect.sync(() => {
    requestAnimationFrame(() => {
      const feed = document.getElementById('feed');

      if (feed) feed.scrollTop = feed.scrollHeight;
    });
  }).pipe(Effect.as(Message.CompletedEffect())),
});

export const newRequestId = () => crypto.randomUUID();
