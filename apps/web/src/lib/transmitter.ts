// Turns a payload into an endless stream of grid symbols: K systematic
// droplets first, then repair droplets forever, so a receiver can join late.
// An 8-color symbol carries COLOR_PLANES droplets; Auto mode sends every
// AUTO_TWO_COLOR_EVERY-th symbol in 2-color, so a camera that cannot resolve
// colour still makes progress (there is no back channel to ask for a mode).

import {
  COLOR_PLANES,
  LTEncoder,
  MAX_BLOCK_SIZE,
  encodePacket,
  packetToModules,
  packetsToColorModules,
  type Colors,
  type Modules,
} from '@lumina/protocol';

export type TxMode = Colors | 'auto';

export const AUTO_TWO_COLOR_EVERY = 4;

export interface Symbol {
  /** Seed of the first droplet in the symbol. */
  seed: number;
  modules: Modules;
  colors: Colors;
}

/** Average droplets per symbol in a mode. */
export function dropletsPerSymbol(mode: TxMode): number {
  if (mode === 2) return 1;
  if (mode === 8) return COLOR_PLANES;
  return (COLOR_PLANES * (AUTO_TWO_COLOR_EVERY - 1) + 1) / AUTO_TWO_COLOR_EVERY;
}

export class Transmitter {
  readonly encoder: LTEncoder;
  mode: TxMode;
  private count = 0;

  constructor(payload: Uint8Array, sessionId: number, mode: TxMode = 'auto') {
    this.encoder = new LTEncoder(payload, MAX_BLOCK_SIZE, sessionId);
    this.mode = mode;
  }

  get k(): number {
    return this.encoder.k;
  }

  next(): Symbol {
    const n = this.count++;
    const colors: Colors = this.mode === 'auto' ? (n % AUTO_TWO_COLOR_EVERY === AUTO_TWO_COLOR_EVERY - 1 ? 2 : 8) : this.mode;
    const { config } = this.encoder;
    if (colors === 2) {
      const droplet = this.encoder.next();
      return { seed: droplet.seed, modules: packetToModules(encodePacket(config, droplet)), colors };
    }
    const droplets = Array.from({ length: COLOR_PLANES }, () => this.encoder.next());
    return { seed: droplets[0].seed, modules: packetsToColorModules(droplets.map((d) => encodePacket(config, d))), colors };
  }
}

export function randomSessionId(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}
