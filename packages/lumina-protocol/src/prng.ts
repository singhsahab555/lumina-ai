// Deterministic PRNG shared by encoder and decoder. Both sides must derive the
// exact same block selection from a droplet seed, so never swap this for Math.random.

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mixes the droplet seed with the session id so two transmitters on screen at
// once never produce correlated droplets.
export function dropletRng(seed: number, sessionId: number): Rng {
  return mulberry32((Math.imul(seed, 0x9e3779b1) ^ sessionId) >>> 0);
}
