// Luby Transform fountain code.
//
// Seeds 0..K-1 are systematic (droplet i == source block i), so a clean first
// pass of the display loop delivers the file with zero overhead. Seeds >= K are
// random LT droplets that repair whatever frames the camera dropped.

import { dropletRng } from './prng.ts';
import { robustSolitonCdf, sampleDegree, sampleIndices, type SolitonParams, DEFAULT_SOLITON } from './soliton.ts';

// Repair degrees: Robust Soliton + 2, but never below ~K/4. Inactivation
// decoding does not need degree-1 repair droplets (the systematic pass
// supplies those); it needs each repair droplet to hit the few blocks the
// camera missed. With sparse rows, a droplet sent after a 75%-complete
// systematic pass often covers only known blocks and is wasted (+21% overhead
// at K=70); the floor makes it ~+2 droplets in every regime (LOG Day 4). The
// floor's parity is random: rows of one fixed even degree are all orthogonal
// to the all-ones vector, which caps the rank at K-1. Wire format.
const DEGREE_BOOST = 2;
const DENSE_FLOOR_DIVISOR = 4;
const DENSE_FLOOR_CAP = 256;

export interface Droplet {
  seed: number;
  data: Uint8Array;
}

export interface LTConfig {
  sessionId: number;
  totalLength: number;
  blockSize: number;
  soliton?: SolitonParams;
}

export function blockCount(totalLength: number, blockSize: number): number {
  return Math.max(1, Math.ceil(totalLength / blockSize));
}

function xorInto(target: Uint8Array, src: Uint8Array): void {
  if ((target.length & 3) === 0 && (target.byteOffset & 3) === 0 && (src.byteOffset & 3) === 0) {
    const t = new Uint32Array(target.buffer, target.byteOffset, target.length >>> 2);
    const s = new Uint32Array(src.buffer, src.byteOffset, target.length >>> 2);
    for (let i = 0; i < t.length; i++) t[i] ^= s[i];
    return;
  }
  for (let i = 0; i < target.length; i++) target[i] ^= src[i];
}

export class DropletPlanner {
  readonly k: number;
  private readonly cdf: Float64Array;
  private readonly sessionId: number;

  constructor(config: LTConfig) {
    this.k = blockCount(config.totalLength, config.blockSize);
    this.sessionId = config.sessionId;
    this.cdf = robustSolitonCdf(this.k, config.soliton ?? DEFAULT_SOLITON);
  }

  indicesFor(seed: number): number[] {
    if (seed < this.k) return [seed];
    const rng = dropletRng(seed, this.sessionId);
    const degree = sampleDegree(this.cdf, rng) + DEGREE_BOOST;
    const floor = Math.min(Math.ceil(this.k / DENSE_FLOOR_DIVISOR), DENSE_FLOOR_CAP) + (rng() < 0.5 ? 1 : 0);
    return sampleIndices(this.k, Math.min(this.k, Math.max(degree, floor)), rng);
  }
}

export class LTEncoder {
  readonly config: LTConfig;
  readonly k: number;
  private readonly blocks: Uint8Array[];
  private readonly planner: DropletPlanner;
  private nextSeed = 0;

  constructor(data: Uint8Array, blockSize: number, sessionId: number) {
    this.config = { sessionId, totalLength: data.length, blockSize };
    this.planner = new DropletPlanner(this.config);
    this.k = this.planner.k;
    this.blocks = [];
    for (let i = 0; i < this.k; i++) {
      const block = new Uint8Array(blockSize); // zero-padded tail
      block.set(data.subarray(i * blockSize, Math.min((i + 1) * blockSize, data.length)));
      this.blocks.push(block);
    }
  }

  droplet(seed: number): Droplet {
    const data = new Uint8Array(this.config.blockSize);
    for (const i of this.planner.indicesFor(seed)) xorInto(data, this.blocks[i]);
    return { seed, data };
  }

  next(): Droplet {
    return this.droplet(this.nextSeed++);
  }
}

// One equation of the residual GF(2) system: a bit per unsolved block it
// still references, and the XOR of those blocks. As a pivot row (echelon
// form) it has no bits below its pivot column.
interface Row {
  bits: Uint32Array;
  data: Uint8Array;
  weight: number;
  pivot: number;
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function lowestBit(bits: Uint32Array, from: number): number {
  for (let w = from; w < bits.length; w++) {
    const v = bits[w];
    if (v) return (w << 5) + 31 - Math.clz32(v & -v);
  }
  return -1;
}

// Incremental decoding. Systematic droplets solve their block directly; every
// other droplet is reduced on arrival against the pivot rows of a GF(2)
// echelon form, so each droplet costs at most (rank × row width) word XORs
// and no step re-runs a full elimination (the Day 4 decoder did, and froze
// the receiver on multi-MB files). A block solved meanwhile is XORed out of
// every pivot row, which subsumes peeling: rows that drop to one bit solve
// their block and cascade. Once solved + rank == K, back-substitution from
// the highest pivot down recovers the rest.
export class LTDecoder {
  readonly config: LTConfig;
  readonly k: number;
  private readonly planner: DropletPlanner;
  private readonly blocks: (Uint8Array | null)[];
  private readonly words: number;
  private readonly pivots: (Row | null)[];
  private readonly rows = new Set<Row>();
  private readonly queue: Row[] = [];
  private readonly seenSeeds = new Set<number>();
  private solved = 0;
  received = 0;
  /** Blocks recovered from multi-block equations (elimination) rather than a degree-1 droplet. */
  inactivated = 0;

  constructor(config: LTConfig) {
    this.config = config;
    this.planner = new DropletPlanner(config);
    this.k = this.planner.k;
    this.blocks = new Array(this.k).fill(null);
    this.pivots = new Array(this.k).fill(null);
    this.words = (this.k + 31) >>> 5;
  }

  /** Rank recovered / K: grows with every useful droplet, reaches 1 exactly when done. */
  get progress(): number {
    return this.done ? 1 : (this.solved + this.rows.size) / this.k;
  }

  get done(): boolean {
    return this.solved === this.k;
  }

  isSolved(index: number): boolean {
    return this.blocks[index] !== null;
  }

  /** Per block: 0 unknown, 1 pinned by an equation (pivot of an unsolved row), 2 solved. Drawn as the receiver's block matrix. */
  blockStates(): Uint8Array {
    const s = new Uint8Array(this.k);
    for (let i = 0; i < this.k; i++) s[i] = this.blocks[i] ? 2 : this.pivots[i] ? 1 : 0;
    return s;
  }

  /** Returns true once the whole payload is recovered. */
  add(droplet: Droplet): boolean {
    if (this.done || this.seenSeeds.has(droplet.seed)) return this.done;
    this.seenSeeds.add(droplet.seed);
    this.received++;

    const data = droplet.data.slice();
    const unknown: number[] = [];
    for (const i of this.planner.indicesFor(droplet.seed)) {
      const known = this.blocks[i];
      if (known) xorInto(data, known);
      else unknown.push(i);
    }
    if (unknown.length === 0) return this.done;
    if (unknown.length === 1) {
      this.solve(unknown[0], data);
    } else {
      const bits = new Uint32Array(this.words);
      for (const i of unknown) bits[i >>> 5] |= 1 << (i & 31);
      this.queue.push({ bits, data, weight: unknown.length, pivot: -1 });
    }
    this.drain();
    if (this.solved + this.rows.size === this.k) this.backSubstitute();
    return this.done;
  }

  // Reduces queued rows into the echelon form.
  private drain(): void {
    while (this.queue.length > 0) {
      const row = this.queue.pop()!;
      const { bits } = row;
      let from = 0;
      while (row.weight > 0) {
        const c = lowestBit(bits, from);
        if (c < 0) break;
        from = c >>> 5;
        const known = this.blocks[c];
        if (known) {
          // A block solved while this row waited in the queue.
          bits[from] &= ~(1 << (c & 31));
          xorInto(row.data, known);
          row.weight--;
          continue;
        }
        if (row.weight === 1) {
          this.inactivated++;
          this.solve(c, row.data);
          break;
        }
        const p = this.pivots[c];
        if (!p) {
          row.pivot = c;
          this.pivots[c] = row;
          this.rows.add(row);
          break;
        }
        let weight = 0;
        for (let x = from; x < bits.length; x++) weight += popcount((bits[x] ^= p.bits[x]));
        row.weight = weight;
        xorInto(row.data, p.data);
      }
    }
  }

  // Records a solved block and XORs it out of every pivot row. A row that
  // loses its pivot, or drops to one bit, goes back through drain().
  private solve(index: number, data: Uint8Array): void {
    if (this.blocks[index]) return;
    this.blocks[index] = data;
    this.solved++;
    const w = index >>> 5;
    const m = 1 << (index & 31);
    for (const row of this.rows) {
      if (!(row.bits[w] & m)) continue;
      row.bits[w] &= ~m;
      xorInto(row.data, data);
      row.weight--;
      if (row.pivot === index || row.weight <= 1) {
        this.rows.delete(row);
        this.pivots[row.pivot] = null;
        row.pivot = -1;
        this.queue.push(row);
      }
    }
  }

  // Every unsolved block has a pivot row now, and a row only references
  // blocks at or above its pivot, so solving from the top down needs only
  // blocks that are already known.
  private backSubstitute(): void {
    for (let c = this.k - 1; c >= 0; c--) {
      const row = this.pivots[c];
      if (!row) continue;
      const { bits, data } = row;
      for (let w = c >>> 5; w < bits.length; w++) {
        let v = bits[w];
        while (v) {
          const low = v & -v;
          v ^= low;
          const j = (w << 5) + 31 - Math.clz32(low);
          if (j !== c) xorInto(data, this.blocks[j]!);
        }
      }
      this.blocks[c] = data;
      this.pivots[c] = null;
      this.solved++;
      this.inactivated++;
    }
    this.rows.clear();
  }

  result(): Uint8Array {
    if (!this.done) throw new Error(`LT decode incomplete: ${this.solved}/${this.k} blocks`);
    const { blockSize, totalLength } = this.config;
    const out = new Uint8Array(totalLength);
    for (let i = 0; i < this.k; i++) {
      const block = this.blocks[i]!;
      out.set(block.subarray(0, Math.min(blockSize, totalLength - i * blockSize)), i * blockSize);
    }
    return out;
  }
}
