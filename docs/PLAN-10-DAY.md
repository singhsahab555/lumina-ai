# 10-Day Ultra Build Plan: Oct 26 → Nov 4, 2026

Rule: **a working end-to-end demo exists from Day 3 onward.** Every later day adds a capability on top of a demo that already works, so the project can be submitted at any point.

| Day | Date | Goal | Done when |
|---|---|---|---|
| 1 | Mon Oct 26 | Repo, architecture, **LT codec + frame format** | ✅ `npm test` green: systematic pass, 30% loss, repair-only, CRC reject |
| 2 | Tue Oct 27 | `apps/web` scaffold (Vite + React + TS + Tailwind, PWA). **Transmitter**: file picker → deflate → LT → 2-color canvas grid with 4 finders, looping at a configurable symbol rate | ✅ Measured 30 sym/s in headless Edge; `apps/web` test recovers the sample file byte-exact from real canvas screenshots |
| 3 | Wed Oct 28 | **Receiver**: getUserMedia → finder detect → homography (OpenCV.js) → sample grid → packet → LT decoder → download + SHA-256 check | 🎯 **MILESTONE: first file over light between laptop and phone in airplane mode** |
| 4 | Thu Oct 29 | 8-color modulation + calibration border + palette classification. Adaptive 2↔8 fallback. **Inactivation decoding** (Gaussian elimination when peeling stalls) to cut overhead to ~5% | Measured KB/s ≥ 2× Day 3, and repair-only overhead < 10% in tests |
| 5 | Fri Oct 30 | **Muse Spark on the connected sender** (Meta Model API). Semantic packing: a pump-station maintenance log or manual becomes a strict JSON work-order bundle (asset, steps, parameters, limits), validated against a schema before beaming | A 20-page sample log becomes < 5 KB of valid JSON |
| 6 | Sat Oct 31 | **Muse Glimmer verifier on the air-gapped receiver** (Ollama, local). Checks the bundle against a local policy file (allowed assets, parameter limits), flags injected instructions, and renders an actionable checklist | A tampered bundle (out-of-range setpoint plus an injected instruction) gets rejected live with networking off |
| 7 | Sun Nov 1 | **Mode 3: return channel**. The air-gapped machine beams back an ack and telemetry on its own screen. The connected side's webcam + **SAM 3.1** (text prompt "monitor") acquires that screen, and classical tracking decodes it. ECDH key exchange over light | A closed loop runs: work order in, signed ack and telemetry out |
| 8 | Mon Nov 2 | AES-GCM payloads, glare mask, and the telemetry UI: live KB/s, droplet/block matrix, de-warp preview, verifier verdict panel | All demo modes can be selected from one UI |
| 9 | Tue Nov 3 | Hardening: lighting, angles (45° tilt), and a phone as a raw-mode receiver. Perf profiling and bug bash. **Record the 3-min demo video** showing only hackathon-built features | The video is recorded, and 5 consecutive successful live runs are completed |
| 10 | Wed Nov 4 | Freeze at 3 PM ET. README GIFs, video final cut, submission on the CV platform **before 9:00 PM ET** | Submitted, with the repo public, the video link working, and all contributors listed |

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
| **Dev laptop has 8 GB RAM / Intel HD 520: Muse Glimmer 30B cannot run on it** (found Oct 27) | Need a second machine with ≥32 GB RAM or a ≥24 GB GPU as the air-gapped receiver by Day 6. Until then the deterministic policy gate works without the model (verdict fails closed to HOLD). Do not move Glimmer to the cloud: that breaks honesty rule 3. |
| Meta API billing hold failed (Oct 27) | Keep ~₹2,000 on the card for the ~$20 hold and enable international transactions. Fallback for Spark: Baseten Muse Spark Open. Needed by Day 5. |
| Day 3 milestone slips | Everything after it slides. AI features must not start before light transfer works. |

## Hackathon logistics (from the participant guide)

- [x] Deadline: **Wed Nov 4, 9:00 PM ET** via the CV platform. 3-min demo video. Public repo. Max team size 4.
- [x] Track: Indie Developer, problem statement *Push the Frontier* (physical/industrial systems)
- [ ] **Claim $150 in Meta Model API credits** (form in the guide, needs a card on file, deadline Nov 4). Set a spend limit.
- [ ] Optional: Baseten $100 (Muse Spark Open, model id `meta-models/muse-spark-open-1026`), Modal $100
- [ ] Pull Muse Glimmer locally: `ollama pull muse-glimmer` (check that the laptop has enough RAM/VRAM)
- [ ] Get the judging rubric table (it was missing from the pasted guide) and align the demo to it
- [ ] Watch: Agents 102 "Verifiable Agents" (Wed Oct 28, 12 PM ET). It maps directly onto the verifier agent.
