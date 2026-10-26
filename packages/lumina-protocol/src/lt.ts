// Luby Transform fountain code.
//
// Seeds 0..K-1 are systematic (droplet i == source block i), so a clean first
// pass of the display loop delivers the file with zero overhead. Seeds >= K are
// random LT droplets that repair whatever frames the camera dropped.

import { dropletRng } from './prng.ts';
import { robustSolitonCdf, sampleDegree, sampleIndices, type SolitonParams, DEFAULT_SOLITON } from './soliton.ts';

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
    return sampleIndices(this.k, sampleDegree(this.cdf, rng), rng);
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
  private readonly seenSeeds = new Set<number>();
  private solved = 0;
  received = 0;

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
    for (const i of indices) {
      let set = this.waiting.get(i);
      if (!set) this.waiting.set(i, (set = new Set()));
      set.add(pending);
    }
    return this.done;
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
          queue.push([last, p.data]);
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
