// SAM 3.1 output: special-token text, one line per frame (an image is one line).
//   <0f>0<|box;x1=181;y1=365;x2=556;y2=486;w=1516;h=1600|><|mask;x=0;y=0;data=122,376,~...|>,2<|box;...|>...
// Boxes are in source pixels (x1,y1 top-left, x2,y2 bottom-right, w/h the source
// size). Object ids are stable but can be sparse. `c` (0..1) appears only when
// the request sets include_confidence. Masks are base85 and stay undecoded here:
// the return channel only needs the box as a region of interest.
// Grammar: dev.meta.ai/docs/sam/reading-segmentation.

import { ModelHttpError, type TraceEvent } from './types.ts';
import { META_BASE_URL, SAM_MODEL, samSegmentRaw, type MetaConfig } from './meta.ts';

export interface SamBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SamMatch {
  frame: number;
  id: number;
  box: SamBox;
  /** Source frame size the box refers to. */
  width: number;
  height: number;
  confidence: number | null;
  /** Mask height x width, when a mask token followed the box. */
  mask: { rows: number; cols: number; encoding: 'lossless' | 'one_bit' } | null;
}

const fields = (s: string) => Object.fromEntries(s.split(';').map((kv) => kv.split('=') as [string, string]));

/** Parses the raw output text. An empty string is a valid "no matches" answer. */
export function parseSamOutput(text: string): SamMatch[] {
  const out: SamMatch[] = [];
  // Base85 payloads never contain '|', so a token runs to the first '|>'.
  const record = /(\d+)<\|box;([^|]*)\|>(?:<\|mask;([^|]*)\|>)?/g;
  for (const line of text.split('\n')) {
    const head = /^<(\d+)f>/.exec(line.trim());
    if (!head) continue;
    const frame = Number(head[1]);
    for (const m of line.matchAll(record)) {
      const b = fields(m[2]);
      const nums = ['x1', 'y1', 'x2', 'y2', 'w', 'h'].map((k) => Number(b[k]));
      if (nums.some((n) => !Number.isFinite(n))) throw new Error(`SAM box token unreadable: ${m[0].slice(0, 80)}`);
      const [x1, y1, x2, y2, w, h] = nums;
      let mask: SamMatch['mask'] = null;
      if (m[3]) {
        // data=<rows>,<cols>,<~|!><payload>
        const d = /data=(\d+),(\d+),([~!])/.exec(m[3]);
        if (d) mask = { rows: Number(d[1]), cols: Number(d[2]), encoding: d[3] === '!' ? 'one_bit' : 'lossless' };
      }
      out.push({ frame, id: Number(m[1]), box: { x1, y1, x2, y2 }, width: w, height: h, confidence: b.c === undefined ? null : Number(b.c), mask });
    }
  }
  return out;
}

export interface ScreenFind {
  match: SamMatch | null;
  matches: number;
  trace: TraceEvent;
}

/**
 * Asks SAM 3.1 where the far screen is in one camera still. The largest match
 * wins (the plant screen fills more of the view than a stray phone does).
 */
export async function samFindScreen(cfg: MetaConfig, imageDataUrl: string, prompt = 'computer monitor'): Promise<ScreenFind> {
  const t0 = performance.now();
  const model = `${cfg.provider ?? 'meta'}:${cfg.model ?? SAM_MODEL}`;
  try {
    const raw = await samSegmentRaw({ ...cfg, baseUrl: cfg.baseUrl ?? META_BASE_URL }, prompt, imageDataUrl, { include_confidence: 'true', mask_encoding: 'one_bit' });
    const matches = parseSamOutput(raw);
    const area = (m: SamMatch) => (m.box.x2 - m.box.x1) * (m.box.y2 - m.box.y1);
    const match = matches.reduce<SamMatch | null>((best, m) => (!best || area(m) > area(best) ? m : best), null);
    const ms = Math.round(performance.now() - t0);
    return {
      match,
      matches: matches.length,
      trace: { model, op: 'sam.find-screen', ms, inputBytes: imageDataUrl.length, outputBytes: raw.length, ok: true, note: `${matches.length} match(es) for "${prompt}"` },
    };
  } catch (e) {
    const note = e instanceof ModelHttpError ? `HTTP ${e.status}` : e instanceof Error ? e.message : String(e);
    return { match: null, matches: 0, trace: { model, op: 'sam.find-screen', ms: Math.round(performance.now() - t0), inputBytes: imageDataUrl.length, outputBytes: 0, ok: false, note } };
  }
}

/** SAM 3.1 is served only by the Meta Model API: null until MODEL_API_KEY is set. */
export function samFromEnv(env: Record<string, string | undefined>): MetaConfig | null {
  return env.MODEL_API_KEY ? { apiKey: env.MODEL_API_KEY, baseUrl: env.META_BASE_URL || META_BASE_URL, model: env.SAM_MODEL || SAM_MODEL } : null;
}
