// Turns a payload into an endless stream of grid symbols: K systematic
// droplets first, then repair droplets forever, so a receiver can join late.

import { LTEncoder, MAX_BLOCK_SIZE, encodePacket, packetToModules, type Modules } from '@lumina/protocol';

export interface Symbol {
  seed: number;
  modules: Modules;
}

export class Transmitter {
  readonly encoder: LTEncoder;

  constructor(payload: Uint8Array, sessionId: number) {
    this.encoder = new LTEncoder(payload, MAX_BLOCK_SIZE, sessionId);
  }

  get k(): number {
    return this.encoder.k;
  }

  next(): Symbol {
    const droplet = this.encoder.next();
    return { seed: droplet.seed, modules: packetToModules(encodePacket(this.encoder.config, droplet)) };
  }
}

export function randomSessionId(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}
