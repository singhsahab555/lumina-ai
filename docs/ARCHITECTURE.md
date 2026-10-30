# LuminaAI Architecture

## Pipeline

```
 SENDER                                                     RECEIVER
 ┌──────────┐  ┌───────────────┐  ┌────────┐  ┌──────────┐  ┌──────────────┐
 │ File /   │→ │ Compress      │→ │AES-GCM │→ │ LT       │→ │ Frame packet │
 │ prompt   │  │ raw: deflate  │  │(opt.)  │  │ encoder  │  │ hdr+data+CRC │
 └──────────┘  │ neural: Spark │  └────────┘  └──────────┘  └──────┬───────┘
               └───────────────┘                                   │
                                                     ┌─────────────▼────────────┐
                                                     │ Modulator: canvas/WebGL  │
                                                     │ 2-color or 8-color grid  │
                                                     │ + finders + calib border │
                                                     └─────────────┬────────────┘
                                                         light ~~~~│~~~~
                                                     ┌─────────────▼────────────┐
                                                     │ Camera (getUserMedia)    │
                                                     │ → finder detect          │
                                                     │ → homography de-warp     │
                                                     │ → color classify (calib) │
                                                     └─────────────┬────────────┘
 ┌──────────────┐  ┌──────────────┐  ┌────────┐  ┌──────────┐      │
 │ Rehydrate /  │← │ Glimmer      │← │ Decrypt│← │ LT peel  │← CRC-checked packet
 │ act (local)  │  │ verifier     │  │        │  │ decoder  │
 └──────────────┘  └──────────────┘  └────────┘  └──────────┘
```

## Layer decisions

| Layer | Choice | Why |
|---|---|---|
| Fountain code | LT with systematic first pass, Robust Soliton (c=0.05, δ=0.5), deterministic mulberry32 PRNG | A clean pass costs zero overhead, and lost frames are repaired by random droplets. Frames are self-describing, so the receiver can join at any point. |
| Frame integrity | CRC-32 per frame, with no per-frame FEC | Corrupted frames become erasures, which the fountain code already absorbs. Per-frame Reed–Solomon is only worth adding if the measured CRC fail rate is above ~30%. |
| Raw compression | Native `CompressionStream('deflate-raw')` | Zero dependencies and works everywhere. `fzstd` only decodes, so zstd would also need a WASM encoder. |
| Semantic packing | **Muse Spark via the Meta Model API**, on the *connected* sender only. Output must validate against a JSON schema. | The sender is the online side of the bridge, so a cloud call there doesn't break the air gap. **It is lossy** and has to be presented that way (see "Honesty rules"). |
| Air-gapped checks | **Deterministic policy gate in the receiver's browser** (final, fails closed), plus an optional **Muse Glimmer 30B via Ollama** verifier on plant hardware | The gate runs on any device, the phone included, with no network: a tampered order is rejected, a clean one held. Glimmer needs a ≥24 GB GPU or ≥32 GB unified memory, which the demo hardware lacks, so the demo runs the gate only. **Glimmer on NVIDIA NIM is never used here**: a cloud call would put the air-gapped side on the internet. It runs on the sender instead (packer fallback, red-team). |
| Encryption | WebCrypto AES-256-GCM. The key comes from ECDH (Mode 3 bidirectional) or a passphrase via PBKDF2 | Built into the browser, with no crypto dependencies. |
| Modulation | 2-color (1 bit/module) and 8-color (3 bit-planes, one packet each). Transmitter Auto mode = 8-color with every 4th symbol in 2-color | The receiver auto-detects the mode per frame from the calibration border. 8-color plane 0 also reads by luma alone. |
| Geometry | Classical finder patterns + 4-point homography in plain TypeScript ([vision.ts](../packages/lumina-protocol/src/vision.ts)), in a Web Worker | Deterministic, ~30 ms per 720p frame, no 8 MB OpenCV.js download, and unit-testable in Node. |
| SAM 3.1 | Meta Model API, **connected side only**: a text prompt ("computer monitor") acquires and tracks the far screen for the return channel (Mode 3), plus a glare mask. **Not run on every frame** | API-only, so it can't run on the air-gapped side. It provides the ROI at ~1–2 Hz, and the cheap tracker does the per-frame work. |

## Model integration (`packages/lumina-agents`)

Zero-dep TypeScript, runs in Node and the browser. Everything is built around one `ChatModel` interface, so tests use a scripted fake.

| Piece | File | What it does |
|---|---|---|
| Bundle schema | `schema.ts` | `lumina.work-order/v1`: asset, steps, setpoints with a fixed parameter vocabulary, and `kind: "neural-summary"`. The JSON Schema is Meta-strict-compatible and is re-validated locally. |
| Site policy | `policy.ts`, `fixtures/site-policy.json` | Asset allow-list, per-parameter unit and range limits, and an injection-phrase scan. These checks are deterministic and **final**. |
| Spark packer | `packer.ts` | Calls chat completions on the Meta API (strict `json_schema`), Baseten Spark Open or NVIDIA NIM (JSON mode, schema example in the prompt) and retries with the validation errors (up to 3). Provenance (source title, bytes and SHA-256) is set by software, never by the model. |
| Verifier agent | `verifier.ts` | Ollama `/api/chat` agent loop with tools `check_asset`, `check_setpoint` and `scan_text`. The bundle is treated as untrusted data. **The model can add reasons to reject but can never approve what policy blocks** (`modelOverruled`). It fails closed: no model → `hold`. |
| SAM 3.1 | `models/meta.ts` | Request builder for the `POST /v1/responses` stream (text prompt + image). The output parser comes on Day 7. |
| Trace | `models/types.ts` | Each call records model, op, ms, bytes in and out, and ok. This feeds the UI's model-trace panel. |

CLI: `cd packages/lumina-agents && npm run cli -- status | pack <doc> | verify <bundle>` (config in the root `.env`, see `.env.example`).

## Realistic throughput budget

These numbers are for the pitch and for the demo-day expectations.

- Grid 64×64 → 3,648 data modules after finders and the calibration border.
- 8-color: 3 bit-planes × 436 B blocks → 1.3 KB of payload per symbol (2-color: 436 B).
- Phone cameras capture at 30 FPS (60 FPS on some devices) with rolling shutter. The sender **holds each symbol for 2 display refreshes** to avoid torn frames, which gives ~15–30 symbols/s and roughly **15–40 KB/s raw**.
- A 200 KB file → ~5–13 s. A 20-page log of ~60 KB text that Muse Spark distills to ~3 KB (lossy, labeled as such) → **< 1 s**. That gap is the demo.

Report *measured* KB/s in the UI. "Effective semantic throughput" can be shown as a secondary metric only if it is labeled as such.

## Honesty rules (judges will probe these)

1. Raw mode is lossless and SHA-256 verified end to end. Always show the hash match.
2. Neural mode is a *semantic summary*. It must not be presented as compression of the original bytes, and the source hash must not be claimed for it.
3. The *air-gapped side* has to be shown live with networking off. The connected side is allowed to be online. That is the point of the bridge.

## Hackathon constraints (from the participant guide)

- Only Meta models from the guide's list count: Muse Spark/Wonder/Image/Voice Transcribe and SAM 3.1 via the API, and the open-weights Muse Glimmer and Muse Spark Open. **Llama 3.2 and SAM 2 are not on that list.**
- Anti-projects: no medical-advice features, and nothing political or involving war. The demo uses industrial, lab, or energy scenarios only. No defense or patient-record framing.
- The demo video (3 min) may show only work built during the hackathon.

## Wire format

See [packages/lumina-protocol/src/packet.ts](../packages/lumina-protocol/src/packet.ts). It uses a 16-byte header (magic, version, session id, total length, block size, seed), the droplet data, and a CRC-32.

Each packet fills one bit-plane of a symbol: see [grid.ts](../packages/lumina-protocol/src/grid.ts) and [palette.ts](../packages/lumina-protocol/src/palette.ts). The grid is 64×64 modules: four 7×7 finders (the bottom-right one has a hollow core, for orientation), a 1-module calibration border between them (192 modules cycling the 8 palette colours; dark/light in 2-color), and 3,648 data modules = 456 B, so the max block size is 436 B. A 2-color symbol is one plane. An 8-color symbol is three: palette index bit p = plane p = colour channel off (G, R, B), so each module is one of the 8 RGB-cube corners. Data bits of each plane are XORed with that plane's PRNG mask, so padding never renders as solid blocks. Raw-mode payloads are deflate-raw; the receiver inflates after LT decode.

The LT payload is a file envelope ([envelope.ts](../packages/lumina-protocol/src/envelope.ts)): magic `LUMF`, version, SHA-256 of the file, name, then the bytes, all deflated. The receiver recomputes SHA-256 and only shows "verified" on a match. SHA-256 is implemented in TS because `crypto.subtle` is missing on non-secure (plain LAN http) pages.

### Receiver pipeline

Camera frame (downscaled to ≤1280 px) → worker → luma → Bradley adaptive threshold (12% and ≥12 levels below local mean) → 4-connected components → finder = dark ring whose hole holds a separate dark core (core/ring area ≈ 9/24 plain, 1/24 marked) → BR is the marked finder, TL the plain one farthest from it, TR/BL by cross product (a mirrored assignment is also tried) → homography from the four core centroids → sample each module (5 taps). If the border is colourful: per-side palette from the border, nearest-colour classification, 3 planes → 3 packets. Otherwise, or for a failed plane 0: threshold luma against the 9×9-module local mean, then against a border-learned cut → packet → CRC. Only CRC-valid packets reach the per-session LT decoder, so torn rolling-shutter frames are just erasures. The decoder reduces each droplet on arrival into a GF(2) echelon form (solved blocks are XORed out of every row, which subsumes peeling) and back-substitutes once rank reaches K; repair degrees are `max(soliton + 2, min(K/4, 256) ± parity)`. Measured limits on synthetic frames: needs ≥4 px/module; tolerates blur up to ~½ module, any rotation, keystone, 35% brightness gradient.

Planned v2 header fields: payload type (raw / neural-json / handshake), compression flag, encryption flag, and a SHA-256 manifest carried in a dedicated frame.
