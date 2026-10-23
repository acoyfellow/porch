import './styles.css';
import { Duration, Effect, Schema, Stream } from 'effect';
import { Runtime, Subscription, Url } from 'foldkit';
import { FocusSurface, OpenSurface } from './command';
import { Message } from './message';
import { Model } from './model';
import { locationOf } from './route';
import { phoneSocket } from './socket';
import { installScreenWheel } from './wheel';
import { update } from './update';
import { MAX_RECONNECTS, view } from './view';

const Flags = Schema.Struct({ who: Schema.String, now: Schema.Number, workspaceId: Schema.NullOr(Schema.String), surfaceId: Schema.NullOr(Schema.String) });

type Flags = typeof Flags.Type;

const flags = Effect.sync((): Flags => {
  const location = locationOf(globalThis.location.pathname);

  return { who: document.body.dataset['who'] ?? '', now: Date.now(), ...location };
});

const init = (input: Flags) => ({
  model: {
    connection: 'connecting' as const,
    socketEpoch: 0,
    failures: 0,
    machine: null,
    machineOnline: false,
    machineSeenAt: null,
    sidebar: null,
    workspaceId: input.workspaceId,
    surfaceId: input.surfaceId,
    panel: { _tag: 'Waiting' as const },
    draft: '',
    outgoing: [],
    followTail: true,
    collapsed: [],
    now: input.now,
    who: input.who,
    press: null,
    address: '',
    editingAddress: false,
    tracks: {},
    mode: 'live' as const,
    live: 'off' as const,
    liveDetail: '',
  },
  commands: input.surfaceId ? [OpenSurface({ surfaceId: input.surfaceId }), FocusSurface({ surfaceId: input.surfaceId })] : [],
});

const reconnectDelay = (epoch: number) => Duration.millis(epoch === 0 ? 0 : Math.min(10_000, 500 * 2 ** Math.min(epoch, 5)));

const subscriptions = Subscription.make<Model, Message, never>()((entry) => ({
  socket: entry(
    { epoch: Schema.Number, failures: Schema.Number },
    {
      modelToDependencies: (model) => ({ epoch: model.failures > MAX_RECONNECTS ? -1 : model.socketEpoch, failures: model.failures > MAX_RECONNECTS ? 0 : model.failures }),
      dependenciesToStream: ({ epoch, failures }) => (epoch < 0 ? Stream.empty : Stream.fromEffect(Effect.sleep(reconnectDelay(failures))).pipe(Stream.flatMap(() => phoneSocket))),
    },
  ),
  clock: entry(
    { on: Schema.Boolean },
    {
      modelToDependencies: () => ({ on: true }),
      dependenciesToStream: () => Stream.tick(Duration.seconds(30)).pipe(Stream.map(() => Message.Ticked({ now: Date.now() }))),
    },
  ),
}));

const application = Runtime.makeApplication({
  Model,
  Flags,
  init: (input: Flags, _url: Url.Url) => init(input),
  update,
  view,
  subscriptions,
  routing: {
    onUrlRequest: (request) => {
      if (request._tag === 'Internal') {
        const location = locationOf(request.url.pathname);

        return Message.NavigatedTo(location);
      }

      return Message.CompletedEffect();
    },
    onUrlChange: (url) => Message.NavigatedTo(locationOf(url.pathname)),
  },
  container: document.getElementById('root'),
  devTools: false,
});

Runtime.run(application, { flags });

installScreenWheel();

if ('serviceWorker' in navigator && globalThis.location.protocol === 'https:') void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
