// backend/src/agents/agent-version.util.ts

/** Parses one to four numeric parts. Anything else is rejected rather than guessed at. */
export function parseAgentVersion(text: unknown): number[] | null {
  if (typeof text !== "string") return null;
  const pieces = text.trim().split(".");
  if (pieces.length < 1 || pieces.length > 4) return null;
  if (!pieces.every((p) => /^\d{1,9}$/.test(p))) return null;
  return pieces.map(Number);
}

/** Numeric, so 1.10.0 is newer than 1.9.0. */
export function compareAgentVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
