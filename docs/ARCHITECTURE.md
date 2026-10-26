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
| Offline verifier agent | **Muse Glimmer 30B via Ollama**, local on the air-gapped receiver | Open weights (Apache 2.0) with no network needed. It checks bundles against local policy, flags injections, and rehydrates them into an actionable view. Needs a laptop with a GPU or ≥32 GB of unified memory. A phone can't run it, so phones receive in raw mode only. |
| Encryption | WebCrypto AES-256-GCM. The key comes from ECDH (Mode 3 bidirectional) or a passphrase via PBKDF2 | Built into the browser, with no crypto dependencies. |
| Modulation | 2-color (1 bit/module) baseline, 8-color (3 bit/module) when calibration passes | Adaptive. The receiver falls back to 2-color under glare. |
| Geometry | Classical finder patterns + OpenCV.js `findHomography` / `warpPerspective` on every frame | Deterministic and fast enough for every frame. |
| SAM 3.1 | Meta Model API, **connected side only**: a text prompt ("computer monitor") acquires and tracks the far screen for the return channel (Mode 3), plus a glare mask. **Not run on every frame** | API-only, so it can't run on the air-gapped side. It provides the ROI at ~1–2 Hz, and the cheap tracker does the per-frame work. |

## Realistic throughput budget

These numbers are for the pitch and for the demo-day expectations.

- Grid 64×64 → ~3,600 data modules after finders and the calibration border.
- 8-color: 3 bits/module → ~1.3 KB/frame (block size 1024 + 20 B header/CRC).
- Phone cameras capture at 30 FPS (60 FPS on some devices) with rolling shutter. The sender **holds each symbol for 2 display refreshes** to avoid torn frames, which gives ~15–30 symbols/s and roughly **15–40 KB/s raw**.
- A 200 KB file → ~5–13 s. A 20-page log of ~60 KB text that Llama distills to ~3 KB → **< 1 s**. That gap is the demo.

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

Planned v2 header fields: payload type (raw / neural-json / handshake), compression flag, encryption flag, and a SHA-256 manifest carried in a dedicated frame.
