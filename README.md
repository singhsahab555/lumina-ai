# LuminaAI

**Neural-compressed, vision-assisted optical data modem.** Move files and AI context between devices using only a screen and a camera, with no Wi-Fi, Bluetooth, cellular, NFC, or USB involved.

> Status: **Day 1 of a 10-day hackathon build** (Oct 26 – Nov 4, 2026). The fountain-code core works and has tests. The UI, the camera receiver, and the Llama integration are still in progress. See [docs/PLAN-10-DAY.md](docs/PLAN-10-DAY.md).

## Why

RF is often banned, jammed, or unavailable in places like SCIFs, hospitals, hardware vaults, and disaster zones. USB ports carry their own attack surface (BadUSB). A screen and a camera create a one-way, inspectable, physically line-of-sight channel. LuminaAI makes that channel fast, robust, and *smart*:

1. **Semantic compression (Llama 3.2, on-device).** Distill large documents and logs into a compact structured payload before transmission, then rehydrate it on the receiving side.
2. **Rateless fountain codes in color matrices.** The sender loops LT-coded frames. The receiver can join at any moment, skip any frames, and still reconstruct the payload.
3. **Vision-assisted receiving.** Finder-pattern tracking, homography de-warp, and neural color calibration, with SAM 2 used to acquire the screen.
4. **Safety gate.** Llama Guard scans incoming text and code payloads before anything is opened.

Everything runs offline. Both devices can stay in airplane mode.

## Repo layout

```
packages/lumina-protocol   LT fountain encoder/decoder + optical frame format (zero deps, tested)
apps/web                   React PWA: transmitter + receiver  (Day 2+)
docs/                      Architecture, 10-day plan, decisions
```

## Quick start

```bash
# Node >= 22.18 (runs TypeScript natively, no build step)
cd packages/lumina-protocol
npm test
```

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [10-day build plan](docs/PLAN-10-DAY.md)

## Built with Llama

LuminaAI uses Meta Llama 3.2 and Llama Guard 3 under the Llama 3.2 Community License. Model weights are never committed to this repo. They are fetched or cached on the device at runtime.

## License

MIT (code). Model weights are subject to their own licenses.
