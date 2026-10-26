# LuminaAI Architecture

## Pipeline

```
 SENDER                                                     RECEIVER
 ┌──────────┐  ┌───────────────┐  ┌────────┐  ┌──────────┐  ┌──────────────┐
 │ File /   │→ │ Compress      │→ │AES-GCM │→ │ LT       │→ │ Frame packet │
 │ prompt   │  │ raw: deflate  │  │(opt.)  │  │ encoder  │  │ hdr+data+CRC │
 └──────────┘  │ neural: Llama │  └────────┘  └──────────┘  └──────┬───────┘
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
 │ Rehydrate /  │← │ Llama Guard  │← │ Decrypt│← │ LT peel  │← CRC-checked packet
 │ Q&A (Llama)  │  │ safety gate  │  │        │  │ decoder  │
 └──────────────┘  └──────────────┘  └────────┘  └──────────┘
```

## Layer decisions

| Layer | Choice | Why |
|---|---|---|
| Fountain code | LT with systematic first pass, Robust Soliton (c=0.05, δ=0.5), deterministic mulberry32 PRNG | A clean pass costs zero overhead, and lost frames are repaired by random droplets. Frames are self-describing, so the receiver can join at any point. |
| Frame integrity | CRC-32 per frame, with no per-frame FEC | Corrupted frames become erasures, which the fountain code already absorbs. Per-frame Reed–Solomon is only worth adding if the measured CRC fail rate is above ~30%. |
| Raw compression | Native `CompressionStream('deflate-raw')` | Zero dependencies and works everywhere. `fzstd` only decodes, so zstd would also need a WASM encoder. |
| Neural compression | Llama 3.2 1B/3B via WebLLM (WebGPU), with Ollama as fallback | Runs in the browser and stays air-gap honest. **It is lossy** and has to be presented that way (see "Honesty rules"). |
| Encryption | WebCrypto AES-256-GCM. The key comes from ECDH (Mode 3 bidirectional) or a passphrase via PBKDF2 | Built into the browser, with no crypto dependencies. |
| Modulation | 2-color (1 bit/module) baseline, 8-color (3 bit/module) when calibration passes | Adaptive. The receiver falls back to 2-color under glare. |
| Geometry | Classical finder patterns + OpenCV.js `findHomography` / `warpPerspective` on every frame | Deterministic and fast enough for every frame. |
| SAM 2 | Acquiring and re-acquiring the screen region, plus a glare mask. **Not run on every frame** | SAM 2 cannot run at 30–60 FPS on a phone. It provides the ROI, and the cheap tracker does the per-frame work. |
| Safety | Llama Guard 3 1B over decoded text/code before rendering | Treats payloads arriving over the air gap as untrusted. |

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
3. Any statement that the transfer works offline has to be shown live with both devices in airplane mode.

## Wire format

See [packages/lumina-protocol/src/packet.ts](../packages/lumina-protocol/src/packet.ts). It uses a 16-byte header (magic, version, session id, total length, block size, seed), the droplet data, and a CRC-32.

Planned v2 header fields: payload type (raw / neural-json / handshake), compression flag, encryption flag, and a SHA-256 manifest carried in a dedicated frame.
