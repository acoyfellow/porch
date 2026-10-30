# porch

Your cmux sidebar on your phone.

A small daemon on your Mac connects outbound to a Cloudflare Worker. Your phone opens the Worker page behind Cloudflare Access and sees your cmux workspaces and Pi sessions, and can send to them. Nothing listens on your Mac.

| Part | Path |
|---|---|
| Worker and relay (Durable Object) | `src/` |
| Mac daemon: reads cmux and Pi, holds the outbound socket | `daemon/` |
| Phone UI | `client/` |
| Shared message types | `shared/` |
| Deploy: Worker, Access app and daemon service token | `alchemy.run.ts` |

## Deploy

```sh
npm install
npx alchemy deploy     # creates the Worker, the Access app and a service token for the daemon
```

Then run the daemon on your Mac with the service token it prints.

## Check

```sh
./gate.sh
```

## Security

- The phone page sits behind Cloudflare Access. Only the people you allow can open it.
- The daemon authenticates with an Access service token and only dials out.
- Anyone you allow can type into your terminals. Allow only yourself.

MIT licensed.
