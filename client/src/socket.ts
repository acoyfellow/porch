import { Effect, Option, Queue, Schema, Stream } from 'effect';
import { type BrowserInput, type PhoneToRelay, RelayToPhone } from '../../shared/protocol';
import { Message } from './message';

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(RelayToPhone));

let current: WebSocket | null = null;
let wanted: string | null = null;

const sendNow = (message: PhoneToRelay) => {
  if (current?.readyState === WebSocket.OPEN) current.send(JSON.stringify(message));
};

const BROWSER_BAR_PX = 120;

const phoneViewport = () => ({ width: Math.round(globalThis.innerWidth), height: Math.max(240, Math.round(globalThis.innerHeight - BROWSER_BAR_PX)) });

const openMessage = (surfaceId: string | null): PhoneToRelay => ({ _tag: 'Open', surfaceId, ...(surfaceId ? { viewport: phoneViewport() } : {}) });

export const openSurface = (surfaceId: string | null) => {
  wanted = surfaceId;
  sendNow(openMessage(surfaceId));
};

let resizeTimer: ReturnType<typeof setTimeout> | null = null;

globalThis.addEventListener?.('resize', () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (wanted) sendNow(openMessage(wanted));
  }, 400);
});

export const sendBrowser = (surfaceId: string, input: BrowserInput) => sendNow({ _tag: 'Browser', surfaceId, input });

const socketUrl = () => {
  const url = new URL('/phone', globalThis.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  return url.toString();
};

export const phoneSocket: Stream.Stream<Message> = Stream.callback<Message>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const socket = new WebSocket(socketUrl());
      current = socket;
      socket.onopen = () => {
        Queue.offerUnsafe(queue, Message.SocketOpened());
        sendNow(openMessage(wanted));
      };
      socket.onmessage = (event: MessageEvent<string>) => {
        Option.map(decode(event.data), (message) => Queue.offerUnsafe(queue, Message.Received({ message })));
      };
      socket.onclose = () => Queue.offerUnsafe(queue, Message.SocketClosed());

      return socket;
    }),
    (socket) =>
      Effect.sync(() => {
        if (current === socket) current = null;
        socket.close();
      }),
  ).pipe(Effect.andThen(Effect.never)),
);
