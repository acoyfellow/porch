import { Effect, Queue, Schema, Stream } from 'effect';
import { Mount } from 'foldkit';
import { Message } from './message';
import { watchTrack } from './rtc';

export const WatchLive = Mount.defineStream('WatchLive', {
  args: { sessionId: Schema.String, trackName: Schema.String, at: Schema.Number },
  messages: [Message.LiveChanged],
  execute: ({ element, sessionId, trackName, at }) =>
    Stream.callback<typeof Message.LiveChanged.Type>((queue) =>
      Effect.gen(function* () {
        const publish = (state: 'connecting' | 'live' | 'stalled' | 'failed', detail: string) => Queue.offerUnsafe(queue, Message.LiveChanged({ state, detail }));
        publish('connecting', 'opening the camera');
        yield* Effect.acquireRelease(
          Effect.promise(() => watchTrack({ sessionId, trackName, at }, element as HTMLVideoElement, publish)),
          (viewer) => Effect.sync(viewer.close),
        );

        return yield* Effect.never;
      }),
    ),
});
