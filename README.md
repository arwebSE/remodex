<p align="center">
  <img src="assets/koder-mark.svg" alt="Koder" />
</p>

# Koder

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

Koder is a local-first remote client for [Codex](https://openai.com/index/codex/). The long-term product direction is **web-first**: the active client rewrite lives in [`web/`](web/), while the Node bridge and relay continue to be the operational core that talks to your local Codex runtime.

## Status

Be precise about the current state:

- `web/` is the new primary direction and already contains a React + Vite + TypeScript PWA scaffold.
- `phodex-bridge/` and `relay/` are the working backend pieces that drive pairing, session routing, and the local Codex bridge.
- `CodexMobile/` is still in the repo as a **legacy reference client**, not the future product direction.

That means Koder is **web-first in roadmap and branding**, but the browser client is not fully wired into the bridge/relay flow yet.

## Product Model

Koder is being split into two clear paths:

- **Koder OSS**: self-hosted bridge, relay, and web client are free.
- **Koder Cloud**: the hosted web app and hosted infrastructure are the paid offering.

Rules:

- self-hosted usage should stay fully usable and free
- monetization belongs in hosted web/backend layers, not in the open protocol
- the current plan is mild hosted-only annoyware for free cloud users, not a hard product lock

See [Docs/KODER_PRODUCT_SPEC.md](Docs/KODER_PRODUCT_SPEC.md) for the current working direction.

## Repository Layout

```text
.
├── phodex-bridge/   Node bridge package and CLI (`koder`, legacy `remodex`)
├── relay/           Self-hostable relay and optional push service
├── web/             React + Vite + TypeScript PWA client scaffold
├── CodexMobile/     Legacy iOS reference client
├── Docs/            Product notes and self-hosting docs
└── Legal/           Privacy policy and terms from the older app era
```

## Quick Start

### Source Checkout

```sh
git clone https://github.com/arwebSE/koder.git
cd koder
./run-local-koder.sh
```

That starts:

- a local relay
- the local bridge
- QR/bootstrap output for the current bridge flow

To run the new web client scaffold in parallel:

```sh
cd web
npm install
npm run dev
```

### npm Bridge Install

The package is still published under `remodex` during the transition, but it exposes a `koder` command alias.

```sh
npm install -g remodex@latest
koder up
```

The legacy CLI alias still works too.

## Architecture

```text
┌──────────────┐      paired session      ┌───────────────┐      JSON-RPC / stdio      ┌─────────────┐
│  Koder Web   │ ◄──────────────────────► │ koder bridge  │ ◄────────────────────────► │ codex       │
│  / legacy iOS│      via relay           │ on your Mac   │                             │ app-server  │
└──────────────┘                          └───────────────┘                             └─────────────┘
                                                  │
                                                  ▼
                                           ┌─────────────┐
                                           │  relay      │
                                           │  transport  │
                                           └─────────────┘
```

Core properties:

- Codex runs on the user's machine
- git and workspace operations run on the user's machine
- the relay is a transport layer, not the runtime
- session transport is designed for self-hosting

## Commands

The preferred CLI name is `koder`.

- `koder up`
  Starts the bridge. On macOS it uses the background service path; on other platforms it runs in the foreground.
- `koder run`
  Runs the bridge in the foreground.
- `koder start`
  macOS only. Starts the background bridge service without waiting for a QR in the current terminal.
- `koder restart`
  macOS only. Restarts the background bridge service.
- `koder stop`
  macOS only. Stops the background bridge service.
- `koder status`
  macOS only. Prints service and pairing status.
- `koder run-service`
  macOS only. Internal `launchd` service entrypoint.
- `koder reset-pairing`
  Clears saved pairing state so the next connection requires a fresh QR/bootstrap.
- `koder resume`
  Reopens the last active thread in `Codex.app`.
- `koder watch [threadId]`
  Tails a thread rollout in real time.
- `koder --version`
  Prints the installed bridge version.

## Environment

Important variables:

| Variable | Purpose |
| --- | --- |
| `REMODEX_RELAY` | Relay URL for bridge session routing |
| `REMODEX_ADVERTISED_RELAY` | Relay URL advertised to clients when the bridge connects on a different local socket |
| `REMODEX_PUSH_SERVICE_URL` | Optional push HTTP base URL |
| `REMODEX_CODEX_ENDPOINT` | Connect to an existing Codex WebSocket instead of spawning `codex app-server` |
| `REMODEX_REFRESH_ENABLED` | Enables the desktop refresh workaround |
| `REMODEX_REFRESH_DEBOUNCE_MS` | Debounce window for refresh events |
| `REMODEX_REFRESH_COMMAND` | Custom refresh command |
| `REMODEX_CODEX_BUNDLE_ID` | Bundle ID for the Codex desktop app |
| `CODEX_HOME` | Codex data directory |

Examples:

```sh
# Self-hosted relay
REMODEX_RELAY="ws://localhost:9000/relay" koder up

# Existing Codex instance
REMODEX_CODEX_ENDPOINT="ws://localhost:8080" koder up

# Desktop refresh workaround
REMODEX_REFRESH_ENABLED=true koder up
```

## Security Notes

- Koder is local-first: runtime, git, and workspace operations stay on the user's machine.
- The relay code is public and self-hostable.
- The transport is designed so the relay does not need plaintext application payloads after the secure session is established.
- Avoid hardcoding hosted domains into the open-source path.
- For the tightest trust model, run the relay yourself.

## Self-Hosting

For the full self-hosting flow, see [Docs/self-hosting.md](Docs/self-hosting.md).

The short version:

1. run your own relay
2. point the bridge at it with `REMODEX_RELAY`
3. keep hosted assumptions out of the OSS path

## Legacy iOS Client

`CodexMobile/` remains in the repo for protocol reference and migration support. It is no longer the product direction. If you touch it, treat it as compatibility/legacy work unless the user explicitly wants iOS changes.

## Contributing

This repo is still in active transition. Keep changes pragmatic:

- preserve self-hosted behavior
- keep docs honest about what is working today
- avoid reintroducing hardcoded hosted-service assumptions

Read [AGENTS.md](AGENTS.md) before making broad repo changes.

## License

[ISC](LICENSE)
