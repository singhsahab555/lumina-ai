# Build log

Measured numbers per day. Newest first.

## Day 5: semantic packer, live (Fri Oct 30)

- Meta Model API key still blocked (billing hold), so the packer runs on **Meta's open-weight Muse Glimmer 30B hosted on NVIDIA NIM** (`meta/muse-glimmer-30b`). The CLI uses Spark automatically once `MODEL_API_KEY` is set; it falls back to NIM via `NVIDIA_API_KEY`.
- Bug found: NIM returned **HTTP 504** after ~5 min on every non-streamed call, even a one-line ping. Glimmer is a reasoning model (`reasoning_content` first, then `content`), and the gateway times out waiting for the full reply. Fix: an SSE `stream` mode in `MetaChatModel` that drops reasoning and joins content and tool-call deltas.
- **Measured:** `ps07-shift-log-45d.txt` **56,190 B → 1,610 B** schema-valid `lumina.work-order/v1` bundle (35× smaller, lossy summary). 3 attempts, 133–272 s per call, ~11 min total.
- NIM does not enforce the strict `json_schema`: attempt 1 dropped `work_order_id`/`order`, attempt 2 dropped setpoint fields. Local validation + retry-with-errors fixed both. Retry reasons are now recorded in the trace.
- Faithfulness check: all 7 steps and 4 setpoints match the log's action list (lines 867–872); the model split "alarm 7.1, trip 11.0" into two steps, per the one-action-per-step rule.
- First run was **REJECTED** by the offline gate: the model wrote site "North Basin Water Treatment PS-07", while the policy says "North Basin WTP". Fix: `site` is now pinned by software (`LUMINA_SITE`, default the demo policy's site), like provenance. Re-run: no policy findings, verdict **HOLD** (fail-closed until Glimmer verifies on the receiver, Day 6).
- **Web app: "Meta AI packer" panel** on the transmitter. A browser can't call NIM itself (no CORS, and the key would be public), so `apps/web/server/pack-api.ts` adds `/api/pack` to the Vite dev/preview server on the sender laptop. The key stays in `.env`; progress streams as NDJSON (attempts, retry reasons, 5 s keep-alive ticks). Then "Beam this bundle over light".
- On GitHub Pages (static, no helper) the same panel replays the **recorded real run** (`ps07-work-order.run.json`, labelled "recorded run", real per-attempt timings) and beams the same bundle. The CLI now writes that run record next to every bundle.
- A pack takes ~10 min, so the demo uses the recorded run or a pre-started live pack.
- Tests: agents 18/18, protocol 28/28, web 7/7. Web build clean.

## Day 4½: large files (Wed Oct 28)

- **Bug from the first real-tablet test:** files around 43 KB arrived fine, but 1–10 MB files hung at "recovering". The Day 4 decoder re-ran a full GF(2) elimination (O(n³/32)) every few droplets once peeling stalled, which froze the worker. The K/4 repair-degree floor also made every droplet touch thousands of blocks (encoder 6.6 ms per droplet at 10 MB).
- **Fix: incremental elimination.** Each droplet is reduced on arrival against the pivot rows of an echelon form. A block solved meanwhile is XORed out of every pivot row, which subsumes peeling. Back-substitution runs once, at the end. Progress is now rank/K, so the bar moves with every useful droplet.
- **Wire format v3:** the repair-degree floor is capped at 256 (`min(K/4, 256)` ± random parity). This is unchanged for K ≤ 1024 (files under ~440 KB deflated).
- Measured in Node, random data, 436 B blocks:

  | File | Loss | Extra droplets | Decode CPU total | Worst single droplet |
  |---|---|---|---|---|
  | 1 MB | 3% / 25% | 2 / 1 | 0.03 s / 0.19 s | 2 ms / 38 ms |
  | 5 MB | 3% / 25% | 0 / 6 | 0.12 s / 4.7 s | 9 ms / 1.2 s |
  | 10 MB | 3% / 25% | 2 / 3 | 0.44 s / 24.6 s | 39 ms / 5.5 s (the final back-substitution) |

  The encoder now takes ~0.01–0.07 ms per droplet.
- **UI changes:** the transmitter shows the minimum time over light (one pass of K droplets) and warns above 2 min. The receiver shows droplets/s and an ETA.
- **The light channel is now the limit:** 1 MB ≈ 2,300 droplets, about 30 s at 8-color 30 sym/s with a perfect camera; minutes on a real tablet.
- Browser e2e, unchanged at K = 69: 2-color 4.3 KB/s, 8-color 13.3 KB/s, Auto 10.1 KB/s. All byte-exact.

## Day 4: 8-color, calibration border, inactivation decoding (Wed Oct 28)

- **Wire format v2** (packet `VERSION = 2`). The grid edge rows/columns between finders are now a calibration border (192 modules). Data modules: 3,648 = 456 B per plane, so the max block size is 436 B (was 460).
- **8-color = 3 bit-planes.** Palette = RGB cube corners. Palette index bit p = plane p = "channel off" (bit 0 G, bit 1 R, bit 2 B). Each plane is a full packet with its own CRC, so one symbol carries 3 droplets, and a bad plane costs only that droplet. The border cycles through the 8 colours (2-color: alternates dark/light). The receiver averages each colour per border side, blends the 4 side palettes per module (inverse-square distance to the side), and classifies to the nearest colour.
- **Mode is auto-detected per frame**: the border's chroma tells 8-color from 2-color, so the receiver has no setting.
- **2↔8 fallback**, two layers:
  - (a) Plane 0 (G) is luma-separable (white/yellow/cyan/green vs magenta/red/blue/black), so a camera that loses hue still reads 1 droplet per frame by luma. A border-learned threshold beats the local mean here (17 → 0 bit errors). **Limit, measured:** it holds to ~6% crosstalk. At 10% crosstalk, green and magenta both sit at ~0.5 luma, so it is no general answer.
  - (b) So the transmitter's **Auto** mode (default) sends every 4th symbol in 2-color. A colour-blind camera still progresses, and good cameras lose ~17% (2.5 vs 3 droplets per symbol). The transmitter also has forced 2 and 8 modes.
- **Inactivation decoding.** When peeling stalls and the residual droplets number at least the unknown blocks, the decoder runs a bits-only GF(2) rank check, then Gauss-Jordan with the data.
  - Repair-only overhead: pure peeling needed ~26% median at K=200. Elimination plus a degree boost brings this to ~2 extra droplets.
  - Found in the e2e: with sparse repair rows, a droplet sent after a 75%-complete systematic pass often hits only known blocks and is wasted, which cost +21% at K=70. Repair degrees are now `max(soliton + 2, K/4 ± parity)`. Mixed-loss median is +1 to +3 droplets at K = 11–1000.
  - The parity is random because rows of one fixed even degree are all orthogonal to the all-ones vector, which caps the rank at K−1. A benchmark of mine first looked like a PRNG bug because of this.
- **Measured, browser e2e** (`npm run e2e`): the same fake camera for every mode (960×540, tilt, blur, noise, 8% crosstalk, warm cast, 4:2:0 chroma, each symbol twice, every 5th frame torn). The file is 30 KB incompressible (K = 69). All runs SHA-256 verified and byte-exact.

  | Mode | Unique droplets | Over light | Throughput |
  |---|---|---|---|
  | 2-color | 74 | 6.4 s | **4.6 KB/s** |
  | 8-color | 69 | 2.0 s | **14.6 KB/s** (**3.2×**) |
  | Auto | 69 | 2.6 s | 11.3 KB/s |

  Day 3's 2-color decoder would have been slower still (peeling overhead), so ≥2× Day 3 holds with margin. Earlier runs were noisy because the fake video looped: a looping video repeats droplets, which a real screen never does. The video is now 3×K long.
- `readFrame` on 960×540: ~25 ms per 8-color frame, ~30 ms per 2-color frame (Node).
- Bug fixed: in 2-color mode, dark data joined through the border formed a grid-sized "marked finder" that took one of the 3 marked slots. Marked candidates now need 3 plain finders of similar size.
- Tests: protocol 27/27 (new `color.test.ts`: 3 planes under crosstalk/cast/gradient/tilt, auto-detect, luma fallback, 8-color ≤ ½ the symbols of 2-color), web 7/7 (Auto-mode stream through the colour camera; 8-color screenshot fixtures in `test/fixtures/frames8/`), agents 16/16.
- Still not measured: a real phone camera on 8-color. Next real-device test: does the phone resolve all 3 planes, and at what symbol rate?

## Day 3: receiver (built Tue Oct 27, a day early)

- Decision: **no OpenCV.js**. Finder detection + homography are ~300 lines of TS in `lumina-protocol/src/vision.ts`. It's 8 MB less to cache in the PWA, works offline, and the same code runs in Node tests.
- Receiver tab (`#rx`): getUserMedia (rear camera, ideal 1080p60) → frame downscaled to ≤1280 px → Web Worker: `readFrame` → per-session LT decoders → inflate → envelope → SHA-256. Live overlay outlines the locked grid (green = CRC ok, yellow = located but CRC failed). Download button + byte-exact badge.
- File envelope (`LUMF`): name + SHA-256 travel inside the payload, so the receiver verifies the file itself. Transmitter now shows the SHA-256 too.
- **Measured** `readFrame`: 36 ms per 1280×720 frame in Node (88 ms before a fix: noise in dark regions made thousands of speckle blobs; fixed with a ≥12-level contrast floor). In headless Edge's worker: 50 to 100 ms (software rendering).
- Robustness on synthetic camera frames (6 trials each): ≥4 px/module 100% at mild blur; 6 px/module survives blur radius 2; 8 px/module survives radius 4. 3 px/module is unreliable. Torn frames (top half one symbol, bottom another) always fail the CRC and are never decoded wrong.
- Bug fixed: the dark area around the screen "rings" the quiet zone and was taken for a giant marked finder. Rings touching the frame edge are now rejected.
- **Browser e2e** (`npm run e2e`): Edge with a fake webcam fed a Y4M of tilted, blurred, noisy frames (each symbol twice, every 5th frame torn). The 56,190 B shift log (K = 11) came back **SHA-256 verified, byte-exact** via the real download button in ~3 to 4 s.
- LAN: `npm run lan` serves the built app over self-signed HTTPS (phones only allow the camera on secure origins).
- Tests: protocol 19/19, web 5/5, agents 16/16.
- Deployed to GitHub Pages (https://singhsahab555.github.io/lumina-ai/) via `.github/workflows/pages.yml`: a real HTTPS origin, so phones grant the camera and install the PWA offline. Self-signed LAN HTTPS got the camera blocked on the phone.
- CI caught a repo bug: `.gitignore`'s `models/` (meant for weights) had been hiding `packages/lumina-agents/src/models/`. Now tracked.
- 🎯 **MILESTONE reached (Oct 27):** laptop screen → phone camera, phone offline, **two HTML files transferred and SHA-256 verified**. It needed a symbol rate below 30/s on the real camera (30/s works in the synthetic e2e only). Day 9 hardening: measure the best real-camera rate and throughput, and tune for it.

## Day 2+: Tue Oct 27, Meta model groundwork

- New `packages/lumina-agents`: bundle schema + validator, site policy checks, Muse Spark packer (Meta Model API, strict structured output, retry-on-invalid), Muse Glimmer verifier agent (Ollama, tool calls, policy-final, fail-closed), SAM 3.1 request builder, and per-call trace.
- API shapes taken from dev.meta.ai/docs: chat completions are OpenAI-compatible at `api.meta.ai/v1`, the Spark id is `muse-spark-1.3`, and SAM 3.1 uses `/v1/responses`.
- Fixtures: `site-policy.json` (SP-OT-12), `bundle-valid.json`, and `bundle-tampered.json` (discharge limit 9 bar > 6.5, plus an injected "ignore previous policy limits… pre-approved" step).
- Offline result with no model: the tampered bundle is **REJECTED** (2 blocks) and the valid one gets **HOLD** (fail-closed until Glimmer runs).
- Demo source doc: `apps/web/public/samples/ps07-shift-log-45d.txt`, 56 KB synthetic 45-day shift log (generated by `scripts/make-sample-log.ts`).
- Tests: agents 16/16, protocol 10/10, web 2/2.
- Blockers: Meta billing hold failed (card balance). This laptop (8 GB RAM) cannot run Glimmer 30B.

## Day 2: Tue Oct 27, transmitter

- `apps/web` scaffold: Vite 8, React 19, TS, Tailwind 4, PWA (manifest + service worker, works offline).
- Transmitter: file picker / drag-drop / sample work order → `deflate-raw` → LT (block 460 B) → 64×64 2-color canvas grid. A rAF scheduler is aligned to display refreshes, the symbol rate is configurable from 1 to 60/s, and there are pause and single-step controls.
- **Measured** in headless Edge: **30 sym/s at a 61 Hz display** (each symbol held 2 refreshes). Raw 2-color capacity is 460 B/symbol, which gives **13.5 KB/s** at 30 sym/s before LT overhead.
- Sample pump-station log: 1,553 B → 883 B deflated (57%), K = 2 blocks.
- Screenshot decode: `npm run capture` saves real canvas screenshots (688 px, ~9.6 px/module, non-integer scaling). The `apps/web` test reads them from PNG, samples the modules, CRC-checks them, LT-decodes and inflates them, and gets the file back **byte-exact**.
- Fixed during the day: dark page chrome around the grid broke the bounding-box sampler. Dark regions that touch the image border are now flood-filled out as background.
- Protocol tests: 10/10. Web tests: 2/2.
- Open for Day 3: the payload type and compression flag are not in the header yet (planned for v2), so the receiver assumes raw mode means deflate-raw.

## Day 1: Mon Oct 26, codec

- LT fountain codec with a systematic first pass, Robust Soliton (c=0.05, δ=0.5), and a 16 B header + CRC-32 frame. Five tests pass.
- Repair-only overhead: median ~26% at K=200 and ~16% at K=400 (peeling only).
