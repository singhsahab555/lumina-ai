// Return channel: the plant answers over light with a signed acknowledgement.
// The ack names the exact file it received (SHA-256), the plant's decision on
// it, and receive telemetry. It is signed with an ECDSA P-256 key made on the
// plant device; the private key is non-extractable and never leaves it. The
// connected side pins the key's fingerprint the first time an operator
// confirms it against the plant screen (trust on first use), so a forged ack
// from any other device fails, and a replayed one names the wrong file.

import { sha256, toHex } from '@lumina/protocol';

export const ACK_SCHEMA = 'lumina.ack/v1';

export type AckDecision = 'approve' | 'hold' | 'reject' | 'received';

export interface AckTelemetry {
  /** Seconds from the first valid frame to the verified file. */
  seconds: number;
  frames: number;
  crcValid: number;
  droplets: number;
  k: number;
}

export interface AckBody {
  file_name: string;
  file_sha256: string;
  file_bytes: number;
  /** Set when the file was a work-order bundle. */
  work_order_id: string | null;
  decision: AckDecision;
  /** What decided: the offline policy gate, or gate + model. */
  decided_by: string;
  findings: { code: string; path: string }[];
  telemetry: AckTelemetry;
  issued_at: string;
}

export interface SignedAck {
  schema: typeof ACK_SCHEMA;
  body: AckBody;
  /** Raw uncompressed P-256 public key (65 B), base64url. */
  key: string;
  /** ECDSA P-256 / SHA-256 signature over the UTF-8 JSON of `body`, base64url. */
  sig: string;
}

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

export const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Short fingerprint people can compare by eye: first 8 bytes of SHA-256(raw key), in groups. */
export function keyFingerprint(rawKey: Uint8Array): string {
  return (toHex(sha256(rawKey)).slice(0, 16).match(/..../g) ?? []).join(' ');
}

export const generatePlantKey = (): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify']) as Promise<CryptoKeyPair>;

export async function signAck(body: AckBody, keys: CryptoKeyPair): Promise<SignedAck> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const sig = new Uint8Array(await crypto.subtle.sign(SIGN, keys.privateKey, new TextEncoder().encode(JSON.stringify(body))));
  return { schema: ACK_SCHEMA, body, key: b64url(raw), sig: b64url(sig) };
}

/** The received file as an ack, or null when it is any other file. Says nothing about the signature. */
export function parseAck(bytes: Uint8Array): SignedAck | null {
  try {
    const a = JSON.parse(new TextDecoder().decode(bytes)) as SignedAck;
    return a?.schema === ACK_SCHEMA && typeof a.key === 'string' && typeof a.sig === 'string' && typeof a.body?.file_sha256 === 'string' ? a : null;
  } catch {
    return null;
  }
}

export interface AckCheck {
  signatureOk: boolean;
  fingerprint: string;
}

export async function verifyAck(ack: SignedAck): Promise<AckCheck> {
  let fingerprint = '';
  try {
    const raw = fromB64url(ack.key);
    fingerprint = keyFingerprint(raw);
    const key = await crypto.subtle.importKey('raw', raw as BufferSource, ECDSA, false, ['verify']);
    // JSON.parse keeps key order, so re-serialising the body gives the signed bytes back.
    const data = new TextEncoder().encode(JSON.stringify(ack.body));
    return { signatureOk: await crypto.subtle.verify(SIGN, key, fromB64url(ack.sig) as BufferSource, data), fingerprint };
  } catch {
    return { signatureOk: false, fingerprint };
  }
}

// ── storage (browser only) ───────────────────────────────────────────────

const DB = 'lumina';
const STORE = 'keys';

function idb<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = op(open.result.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    };
  });
}

/**
 * This device's plant key, made once and kept in IndexedDB (a CryptoKey
 * survives structured cloning without its private half ever being exported).
 * `persistent` is false when storage is blocked, so the key lasts one page load.
 */
export async function plantKey(): Promise<{ keys: CryptoKeyPair; persistent: boolean }> {
  try {
    const stored = await idb<CryptoKeyPair | undefined>('readonly', (s) => s.get('plant'));
    if (stored) return { keys: stored, persistent: true };
    const keys = await generatePlantKey();
    await idb('readwrite', (s) => s.put(keys, 'plant'));
    return { keys, persistent: true };
  } catch {
    return { keys: await generatePlantKey(), persistent: false };
  }
}

const TRUSTED = 'lumina.trustedPlantKeys';
const LAST_BEAM = 'lumina.lastBeam';

export function trustedKeys(): string[] {
  try {
    return JSON.parse(localStorage.getItem(TRUSTED) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export function trustKey(fingerprint: string) {
  try {
    localStorage.setItem(TRUSTED, JSON.stringify([...new Set([...trustedKeys(), fingerprint])]));
  } catch {
    // Storage blocked: trust lasts until the page reloads (the caller keeps it in state).
  }
}

export interface LastBeam {
  name: string;
  sha256: string;
  at: string;
}

/** The transmitter records what it last beamed, so an ack can be matched to it. */
export function rememberBeam(beam: LastBeam) {
  try {
    localStorage.setItem(LAST_BEAM, JSON.stringify(beam));
  } catch {
    // Without storage the ack still verifies; it just can't be matched to the sent file.
  }
}

export function lastBeam(): LastBeam | null {
  try {
    return JSON.parse(localStorage.getItem(LAST_BEAM) ?? 'null') as LastBeam | null;
  } catch {
    return null;
  }
}
