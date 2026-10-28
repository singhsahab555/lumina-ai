// Receiver state machine, independent of the camera so it runs in a worker
// and in Node tests: frames in, LT progress out, a verified file at the end.
// Each session id gets its own decoder, so a stray frame from an old transfer
// still on someone's screen cannot poison the current one.

import { LTDecoder, openEnvelope, readFrame, toHex, type Colors, type Point, type RgbaImage } from '@lumina/protocol';
import { inflateRaw } from './deflate.ts';

const MAX_SESSIONS = 4;

export interface RxStats {
  frames: number;
  /** Frames where a grid was located. */
  located: number;
  /** Frames with at least one packet that passed the CRC. */
  valid: number;
  /** CRC-valid packets: up to 3 per 8-color frame. */
  packets: number;
  /** Mode of the last located frame, as its calibration border showed. */
  colors: Colors;
  sessionId: number | null;
  k: number;
  solved: number;
  /** Unique droplets fed to the active decoder. */
  received: number;
}

export interface FrameReport {
  quad: Point[] | null;
  valid: boolean;
  /** Packets that passed the CRC in this frame. */
  planes: number;
  colors: Colors;
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
  packets = 0;
  colors: Colors = 2;

  /** Returns the compressed payload once its decoder completes. */
  push(img: RgbaImage): { report: FrameReport; payload: Uint8Array | null } {
    this.frames++;
    const r = readFrame(img);
    if (r.quad) {
      this.located++;
      this.colors = r.colors;
    }
    const report: FrameReport = { quad: r.quad, valid: r.packets.length > 0, planes: r.packets.length, colors: r.colors };
    if (!report.valid) return { report, payload: null };

    this.valid++;
    let payload: Uint8Array | null = null;
    for (const { config, droplet } of r.packets) {
      this.packets++;
      let dec = this.decoders.get(config.sessionId);
      if (!dec) {
        if (this.decoders.size >= MAX_SESSIONS) this.decoders.delete(this.decoders.keys().next().value!);
        dec = new LTDecoder(config);
        this.decoders.set(config.sessionId, dec);
      }
      const wasDone = dec.done;
      dec.add(droplet);
      if (this.active === null || dec.progress >= (this.decoders.get(this.active)?.progress ?? 0)) this.active = config.sessionId;
      if (dec.done && !wasDone) payload = dec.result();
    }
    return { report, payload };
  }

  stats(): RxStats {
    const dec = this.active === null ? undefined : this.decoders.get(this.active);
    return {
      frames: this.frames,
      located: this.located,
      valid: this.valid,
      packets: this.packets,
      colors: this.colors,
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
