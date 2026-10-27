# Build log

Measured numbers per day. Newest first.

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
