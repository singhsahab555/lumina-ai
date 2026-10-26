# 10-Day Ultra Build Plan: Oct 26 → Nov 4, 2026

Rule: **a working end-to-end demo exists from Day 3 onward.** Every later day adds a capability on top of a demo that already works, so the project can be submitted at any point.

| Day | Date | Goal | Done when |
|---|---|---|---|
| 1 | Mon Oct 26 | Repo, architecture, **LT codec + frame format** | ✅ `npm test` green: systematic pass, 30% loss, repair-only, CRC reject |
| 2 | Tue Oct 27 | `apps/web` scaffold (Vite + React + TS + Tailwind, PWA). **Transmitter**: file picker → deflate → LT → 2-color canvas grid with 4 finders, looping at a configurable symbol rate | The grid animates at 30 symbols/s and a frame can be decoded from a screenshot in a unit test |
| 3 | Wed Oct 28 | **Receiver**: getUserMedia → finder detect → homography (OpenCV.js) → sample grid → packet → LT decoder → download + SHA-256 check | 🎯 **MILESTONE: first file over light between laptop and phone in airplane mode** |
| 4 | Thu Oct 29 | 8-color modulation + calibration border + palette classification. Adaptive 2↔8 fallback. **Inactivation decoding** (Gaussian elimination when peeling stalls) to cut overhead to ~5% | Measured KB/s ≥ 2× Day 3, and repair-only overhead < 10% in tests |
| 5 | Fri Oct 30 | **Llama 3.2 on sender** (WebLLM, `Llama-3.2-1B-Instruct-q4f16_1`). Neural mode: doc → strict JSON schema (entities, timeline, vitals/state) → pack | A 20-page sample log becomes < 5 KB of JSON |
| 6 | Sat Oct 31 | **Llama on receiver**: rehydrate the JSON into a readable report plus an offline Q&A panel. **Llama Guard 3 1B** safety gate (Ollama fallback if it won't run in WebLLM) | A prompt-injection payload gets blocked live |
| 7 | Sun Nov 1 | **Mode 3: agent-to-agent handshake**. Bidirectional: each device runs TX and RX at the same time, ECDH key exchange over light, agents exchange a tool call and a signed result | Two laptops trade a signed message with no network |
| 8 | Mon Nov 2 | AES-GCM payloads, SAM 2 screen acquisition + glare mask (ONNX Runtime Web, tiny model, ROI only), and the telemetry UI: live KB/s, droplet/block matrix, de-warp preview | All three demo modes can be selected from one UI |
| 9 | Tue Nov 3 | Hardening: different phones, lighting, and angles (45° tilt). Perf profiling, offline PWA cache of models, bug bash. **Record the backup demo video** | The video is recorded, and 5 consecutive successful live runs are completed |
| 10 | Wed Nov 4 | **Code freeze at noon.** README GIFs, pitch deck (3 min), submission form, rehearsal ×3 | Submitted |

## Daily rhythm

- Start: read this file, then pick that day's row.
- End: commit and push, tick the row, and log measured numbers in `docs/LOG.md`.

## Risk register

| Risk | Mitigation |
|---|---|
| WebGPU/WebLLM not available on the judge's phone | The phone only *receives* in raw mode. Llama runs on the laptop. Ollama is the fallback on the laptop. |
| Camera autofocus/exposure fights the flashing screen | Lock exposure via `applyConstraints` where it's supported, use a calibration border, and keep 2-color as the fallback |
| Rolling shutter tears frames | Hold symbols ≥2 refreshes, and let CRC drop torn frames |
| SAM 2 too slow | It is used only for acquisition. Classical tracking does the per-frame work. |
| Day 3 milestone slips | Everything after it slides. AI features must not start before light transfer works. |

## Before Day 2: confirm hackathon rules

- [ ] Official rules: deadline/timezone, submission format, video length, required Meta tech, team size
- [ ] Llama license attribution ("Built with Llama") is present in the README and the UI
- [ ] Whether the repo must be public at submission (it already is)
