/** MurmurHash2 (32-bit), the hash Source 2 binaries token launch options with. Seed 0x31415926 */
export function murmur2(str: string, seed = 0x31415926): number {
  const bytes = new TextEncoder().encode(str);
  const m = 0x5bd1e995;
  let h = (seed ^ bytes.length) >>> 0;
  let i = 0;

  while (i + 4 <= bytes.length) {
    let k = (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
    k = Math.imul(k, m);
    k ^= k >>> 24;
    k = Math.imul(k, m);
    h = Math.imul(h, m);
    h = (h ^ k) >>> 0;
    i += 4;
  }

  const rem = bytes.length - i;
  if (rem >= 3) h = (h ^ (bytes[i + 2] << 16)) >>> 0;
  if (rem >= 2) h = (h ^ (bytes[i + 1] << 8)) >>> 0;
  if (rem >= 1) {
    h = (h ^ bytes[i]) >>> 0;
    h = Math.imul(h, m);
  }

  h ^= h >>> 13;
  h = Math.imul(h, m);
  h ^= h >>> 15;
  return h >>> 0;
}
