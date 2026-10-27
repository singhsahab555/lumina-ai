// Receiver state machine, independent of the camera so it runs in a worker
// and in Node tests: frames in, LT progress out, a verified file at the end.
// Each session id gets its own decoder, so a stray frame from an old transfer
// still on someone's screen cannot poison the current one.

import { LTDecoder, openEnvelope, readFrame, toHex, type Point, type RgbaImage } from '@lumina/protocol';
import { inflateRaw } from './deflate.ts';

const MAX_SESSIONS = 4;

export interface RxStats {
  frames: number;
  /** Frames where a grid was located. */
  located: number;
  /** Frames that passed the CRC. */
  valid: number;
  sessionId: number | null;
  k: number;
  solved: number;
  /** Unique droplets fed to the active decoder. */
  received: number;
}

export interface FrameReport {
  quad: Point[] | null;
  valid: boolean;
  seed: number | null;
}

export interface ReceivedFile {
  name: string;
  bytes: Uint8Array;
  sha256: string;
  expectedSha256: string;
  verified: boolean;
  compressedBytes: number;
}

export class ReceiverSession {
  private readonly decoders = new Map<number, LTDecoder>();
  private active: number | null = null;
  frames = 0;
  located = 0;
  valid = 0;

  /** Returns the compressed payload once its decoder completes. */
  push(img: RgbaImage): { report: FrameReport; payload: Uint8Array | null } {
    this.frames++;
    const r = readFrame(img);
    if (r.quad) this.located++;
    if (!r.packet) return { report: { quad: r.quad, valid: false, seed: null }, payload: null };

    this.valid++;
    const { config, droplet } = r.packet;
    let dec = this.decoders.get(config.sessionId);
    if (!dec) {
      if (this.decoders.size >= MAX_SESSIONS) this.decoders.delete(this.decoders.keys().next().value!);
      dec = new LTDecoder(config);
      this.decoders.set(config.sessionId, dec);
    }
    const wasDone = dec.done;
    dec.add(droplet);
    if (this.active === null || dec.progress >= (this.decoders.get(this.active)?.progress ?? 0)) this.active = config.sessionId;
    const report = { quad: r.quad, valid: true, seed: droplet.seed };
    return { report, payload: dec.done && !wasDone ? dec.result() : null };
  }

  stats(): RxStats {
    const dec = this.active === null ? undefined : this.decoders.get(this.active);
    return {
      frames: this.frames,
      located: this.located,
      valid: this.valid,
      sessionId: this.active,
      k: dec?.k ?? 0,
      solved: dec ? Math.round(dec.progress * dec.k) : 0,
      received: dec?.received ?? 0,
    };
  }
}

/** Inflates and opens the envelope; `verified` is the SHA-256 check. */
export async function unpack(payload: Uint8Array): Promise<ReceivedFile> {
  const env = openEnvelope(await inflateRaw(payload));
  return {
    name: env.name,
    bytes: env.file,
    sha256: toHex(env.sha256),
    expectedSha256: toHex(env.expectedSha256),
    verified: env.verified,
    compressedBytes: payload.length,
  };
}
