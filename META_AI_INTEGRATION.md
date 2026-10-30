# Meta AI integration

LuminaAI moves files from a connected machine to an air-gapped one over light: a screen shows coded frames and a camera reads them. The light link carries roughly 5–13 KB/s (see [docs/LOG.md](docs/LOG.md)), so the hard question is what is worth sending, and whether the air-gapped side can trust what arrives. Meta models answer both questions, one on each side of the gap.

```
connected side                          │  air-gapped side
                                        │
document ─► Muse Spark ─► work order ─► │ ─► light link ─► Muse Glimmer ─► approve / reject / hold
            (pack, lossy)  (~KB JSON)   │   (LT fountain)  (local, Ollama)
photo ───► SAM 3.1 ─► cropped region ─► │
```

All model code is in [`packages/lumina-agents`](packages/lumina-agents). It has no dependencies and is written in TypeScript, so it runs in Node and in the browser.

## Models and roles

| Model | Where it runs | Role | Code |
|---|---|---|---|
| **Muse Spark** (`muse-spark-1.3`) | Meta Model API, connected side | Packs a long document into a compact `lumina.work-order/v1` JSON bundle using strict structured output | [`packer.ts`](packages/lumina-agents/src/packer.ts), [`models/meta.ts`](packages/lumina-agents/src/models/meta.ts) |
| **SAM 3.1** (`sam-3.1`) | Meta Model API, connected side | Segments the region that matters (a gauge, a nameplate) so a cropped image is sent instead of the whole photo | [`models/meta.ts`](packages/lumina-agents/src/models/meta.ts) |
| **Muse Glimmer** (open weights, Apache 2.0) | Ollama, air-gapped side | Tool-using verifier agent that reviews every received bundle before anyone acts on it | [`verifier.ts`](packages/lumina-agents/src/verifier.ts), [`models/ollama.ts`](packages/lumina-agents/src/models/ollama.ts) |

## Muse Spark: semantic packing

- `POST https://api.meta.ai/v1/chat/completions` with `response_format.json_schema` and `strict: true`.
- The schema ([`schema.ts`](packages/lumina-agents/src/schema.ts)) uses a fixed parameter vocabulary. Every response is re-validated locally. Invalid output is sent back to the model with the validation errors, up to 3 attempts.
- Provenance (source title, byte count, SHA-256) and the target site are filled in by software, never by the model.
- **Fallback host:** without a Meta Model API key, the same packer runs on Meta's open-weight Muse Glimmer 30B on NVIDIA NIM (`meta/muse-glimmer-30b`), streamed over SSE. NIM does not enforce the strict schema, so the local validator + retry loop matters there.
- **This is lossy.** A Spark bundle is a summary, marked `kind: "neural-summary"`. It is never presented as lossless compression. The original file can still be sent byte-exact over the same link, with its SHA-256 checked on arrival.

## Muse Glimmer: offline verifier agent

- Runs an Ollama `/api/chat` agent loop with three tools: `check_asset`, `check_setpoint` and `scan_text` (prompt-injection phrases).
- The bundle is treated as untrusted data, never as instructions.
- The deterministic site-policy checks ([`policy.ts`](packages/lumina-agents/src/policy.ts)) are final. The model can add reasons to reject, but **it can never approve a bundle that policy blocks**; that case is recorded as `modelOverruled`.
- It fails closed: if no model is reachable, the decision is `hold`.

## SAM 3.1: what to send from a photo

- Builds the request for the `POST /v1/responses` stream (text prompt plus image) on the connected side.
- A crop of about 40 KB crosses the link in seconds; a full 1 MB photo would take minutes.

## Traceability

Each model call records the model, the operation, latency, bytes in and out, and success ([`models/types.ts`](packages/lumina-agents/src/models/types.ts)). The UI's model-trace panel reads this record.

## Status

| Piece | State |
|---|---|
| Spark packer, Glimmer verifier, policy checks | Implemented. Tested against a scripted fake model (`npm test`). |
| Packer, live | Run Oct 30 on Muse Glimmer 30B via NVIDIA NIM: 56,190 B shift log → 1,610 B valid bundle ([`ps07-work-order.json`](apps/web/public/samples/ps07-work-order.json)), passes the offline policy gate. |
| SAM 3.1 | Request builder done. Output parser and UI crop still to do. |
| Live Meta Model API calls | Waiting on API access (NIM fallback in use). The CLI is ready: `cd packages/lumina-agents && npm run cli -- status \| pack <doc> \| verify <bundle>` |
| Web app: pack before send | Done. Transmitter "Meta AI packer" panel: live via the local `/api/pack` helper (`npm run dev -w @lumina/web`, key stays in `.env`), recorded-run replay on GitHub Pages. |
| Web app: verify after receive | Day 6 |

## Configuration

Copy `.env.example` to `.env` at the repo root and set `MODEL_API_KEY`. Keys are never committed. Model weights are never committed either: Glimmer is pulled locally with Ollama.
