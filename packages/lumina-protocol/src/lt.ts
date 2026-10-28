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
    const floor = Math.ceil(this.k / DENSE_FLOOR_DIVISOR) + (rng() < 0.5 ? 1 : 0);
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

interface Pending {
  indices: Set<number>;
  data: Uint8Array;
}

export class LTDecoder {
  readonly config: LTConfig;
  readonly k: number;
  private readonly planner: DropletPlanner;
  private readonly blocks: (Uint8Array | null)[];
  private readonly waiting = new Map<number, Set<Pending>>();
  /** Droplets still referencing 2+ unsolved blocks: the residual system. */
  private readonly pending = new Set<Pending>();
  private readonly seenSeeds = new Set<number>();
  private solved = 0;
  private nextInactivation = 0;
  received = 0;
  /** Blocks recovered by Gaussian elimination rather than peeling. */
  inactivated = 0;

  constructor(config: LTConfig) {
    this.config = config;
    this.planner = new DropletPlanner(config);
    this.k = this.planner.k;
    this.blocks = new Array(this.k).fill(null);
  }

  get progress(): number {
    return this.solved / this.k;
  }

  get done(): boolean {
    return this.solved === this.k;
  }

  isSolved(index: number): boolean {
    return this.blocks[index] !== null;
  }

  /** Returns true once the whole payload is recovered. */
  add(droplet: Droplet): boolean {
    if (this.done || this.seenSeeds.has(droplet.seed)) return this.done;
    this.seenSeeds.add(droplet.seed);
    this.received++;

    const data = droplet.data.slice();
    const indices = new Set<number>();
    for (const i of this.planner.indicesFor(droplet.seed)) {
      const known = this.blocks[i];
      if (known) xorInto(data, known);
      else indices.add(i);
    }

    if (indices.size === 0) return this.done;
    if (indices.size === 1) {
      this.resolve(indices.values().next().value as number, data);
      return this.done;
    }

    const pending: Pending = { indices, data };
    this.pending.add(pending);
    for (const i of indices) {
      let set = this.waiting.get(i);
      if (!set) this.waiting.set(i, (set = new Set()));
      set.add(pending);
    }
    const unknown = this.k - this.solved;
    if (this.pending.size >= unknown && this.received >= this.nextInactivation) {
      // Retry spacing grows with the system size so big files stay cheap.
      if (!this.inactivate()) this.nextInactivation = this.received + 1 + (unknown >>> 8);
    }
    return this.done;
  }

  // Inactivation decoding: when peeling stalls, the residual droplets form a
  // linear system over GF(2) in the unsolved blocks. A bits-only elimination
  // checks it has full rank; only then is the (expensive) block data reduced.
  // This turns the ~25% repair-only overhead of pure peeling into ~2 droplets.
  private inactivate(): boolean {
    const cols: number[] = [];
    const colOf = new Map<number, number>();
    for (let i = 0; i < this.k; i++) {
      if (!this.blocks[i]) {
        colOf.set(i, cols.length);
        cols.push(i);
      }
    }
    const n = cols.length;
    const words = (n + 31) >>> 5;
    const eqs = [...this.pending];
    const bits = eqs.map((p) => {
      const row = new Uint32Array(words);
      for (const i of p.indices) {
        const c = colOf.get(i)!;
        row[c >>> 5] |= 1 << (c & 31);
      }
      return row;
    });

    // Pass 1: rank check on a copy of the bit rows.
    const probe = bits.map((r) => r.slice());
    let rank = 0;
    for (let c = 0; c < n && rank < n; c++) {
      const w = c >>> 5;
      const m = 1 << (c & 31);
      let r = rank;
      while (r < probe.length && !(probe[r][w] & m)) r++;
      if (r === probe.length) return false;
      [probe[rank], probe[r]] = [probe[r], probe[rank]];
      const pivot = probe[rank];
      for (let j = rank + 1; j < probe.length; j++) {
        const row = probe[j];
        if (row[w] & m) for (let x = w; x < words; x++) row[x] ^= pivot[x];
      }
      rank++;
    }

    // Pass 2: Gauss-Jordan with data, so each pivot row ends as one block.
    const data = eqs.map((p) => p.data.slice());
    for (let c = 0; c < n; c++) {
      const w = c >>> 5;
      const m = 1 << (c & 31);
      let r = c;
      while (!(bits[r][w] & m)) r++;
      [bits[c], bits[r]] = [bits[r], bits[c]];
      [data[c], data[r]] = [data[r], data[c]];
      const pivot = bits[c];
      for (let j = 0; j < bits.length; j++) {
        if (j === c || !(bits[j][w] & m)) continue;
        const row = bits[j];
        for (let x = 0; x < words; x++) row[x] ^= pivot[x];
        xorInto(data[j], data[c]);
      }
    }
    this.inactivated += n;
    for (let c = 0; c < n; c++) this.resolve(cols[c], data[c]);
    this.pending.clear();
    this.waiting.clear();
    return true;
  }

  // Belief-propagation "peeling": each newly solved block is XORed out of every
  // droplet that references it, which may cascade into more degree-1 droplets.
  private resolve(index: number, data: Uint8Array): void {
    const queue: [number, Uint8Array][] = [[index, data]];
    while (queue.length > 0) {
      const [i, block] = queue.pop()!;
      if (this.blocks[i]) continue;
      this.blocks[i] = block;
      this.solved++;

      const dependents = this.waiting.get(i);
      if (!dependents) continue;
      this.waiting.delete(i);
      for (const p of dependents) {
        xorInto(p.data, block);
        p.indices.delete(i);
        if (p.indices.size === 1) {
          const last = p.indices.values().next().value as number;
          this.waiting.get(last)?.delete(p);
          this.pending.delete(p);
          queue.push([last, p.data]);
        } else if (p.indices.size === 0) {
          this.pending.delete(p);
        }
      }
    }
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
