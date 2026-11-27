// frontend/lib/random.ts
//
// Random text from the browser's cryptographic generator, for anything that looks like an identifier, key or secret.

/** `bytes` random bytes as lower-case hex (twice as many characters). */
export function randomHex(bytes = 8): string {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A random number from 0 up to (not including) `max`, without modulo bias. */
export function randomBelow(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const a = new Uint32Array(1);
  do globalThis.crypto.getRandomValues(a); while (a[0] >= limit);
  return a[0] % max;
}
