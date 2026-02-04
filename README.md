# atv-js

Apple TV control library in TypeScript: mDNS discovery, AirPlay/Companion pairing, remote control, and keyboard input.

**Important:** This repository is a partial conversion of the Python project `pyatv`. It is **not** a new, independent library. Only a required subset of `pyatv` functionality was converted, and that conversion was performed with LLM assistance.

## Status

- Partial port intended for specific internal use cases.
- APIs and behavior follow `pyatv` as closely as practical, but coverage is incomplete.
- Expect gaps versus `pyatv` and treat this as experimental.

## Scope (current)

- mDNS discovery of Apple TV devices
- AirPlay pairing
- Companion protocol pairing and pair-verify
- Remote control key events
- Keyboard input (text get/set, focus state)

## Install

```bash
npm install
```

## Build

```bash
npm run build
```

## Examples

Pairing:

```bash
npm run pair
```

Remote control:

```bash
npm run remote
```

Example sources:

- `examples/pair.ts`
- `examples/remote.ts`

## Public API (summary)

Exported from `src/index.ts`:

- `scan(timeout?: number)`
- `startAirPlayPairing(...)`, `finishAirPlayPairing(...)`
- `startCompanionPairing(...)`, `finishCompanionPairing(...)`
- `connect(...)`, `disconnect(...)`, `isConnected(...)`
- `sendKey(...)`, `sendKeyDown(...)`, `sendKeyUp(...)`
- `getKeyboardFocusState(...)`, `getText(...)`, `setText(...)`
- `parseCredentials(...)`, `serializeCredentials(...)`

For details, see `src/index.ts`.

## Origin

This codebase is derived from `pyatv` and intended to mirror a subset of its behavior in TypeScript. It should be treated as a **partial port** of `pyatv`, not a separate or competing implementation.

## Attribution

This project is not affiliated with or endorsed by the `pyatv` maintainers. If you need full Apple TV control functionality, stability, or upstream updates, use `pyatv` directly.

Upstream project:

- `pyatv` (https://pyatv.dev)

## License

This repository includes the MIT license from `pyatv` in `LICENSE.md`.
