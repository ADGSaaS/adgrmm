// backend/src/agents/agent-release.core.ts
//
// Staged rollout of agent updates (roadmap 10.10), the parts that need neither Nest nor a database:
//   - looking at a package slot (stable / candidate / previous) and deciding whether it may be offered,
//   - the offer rule (which package a device in which ring is offered),
//   - promoting a candidate to stable and withdrawing it, as file operations,
//   - the health gate maths and the rules for a promote request.
//
// A slot is a folder with the package file and version.json {version, sha256}. A package is only ever offered when its
// version.json exists, parses, holds a valid version and the sha256 of the package ON DISK matches it.
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { compareAgentVersions, parseAgentVersion } from "./agent-version.util";

/* ------------------------------------------------------------------ rings */

export type Ring = "pilot" | "stable";
export const RINGS: readonly Ring[] = ["pilot", "stable"];
export const ringOf = (v: unknown): Ring | null => (v === "pilot" || v === "stable" ? v : null);
/** A device's own ring wins, then its customer's default, then stable. */
export const effectiveRing = (device: unknown, customer: unknown): Ring => ringOf(device) ?? ringOf(customer) ?? "stable";

/* ------------------------------------------------------------------ slots */

export type SlotName = "stable" | "candidate" | "previous";

export type SlotInspection = {
  slot: SlotName;
  packagePath: string;
  versionPath: string;
  /** absent: nothing there. valid: may be offered. problem: something is there that must not be offered. */
  state: "absent" | "valid" | "problem";
  /** Plain language, only for state "problem". */
  problem: string | null;
  /** From version.json (null when it could not be read). */
  version: string | null;
  parsed: number[] | null;
  /** The sha256 version.json declares. */
  declaredSha256: string | null;
  /** The sha256 of the package file on disk (null when there is none). */
  sha256: string | null;
  sizeBytes: number | null;
  modifiedAt: Date | null;
};

type FileStat = { size: number; mtimeMs: number; ctimeMs: number; ino: number; mtime: Date; isFile(): boolean };
// Keyed by size, times and inode so a package replaced by a file of the same size at the same moment is still hashed again.
const hashCache = new Map<string, { key: string; sha256: string }>();
const statKey = (s: FileStat) => `${s.size}|${s.mtimeMs}|${s.ctimeMs}|${s.ino}`;

async function sha256OfFile(file: string, stat: FileStat): Promise<string> {
  const hit = hashCache.get(file);
  if (hit && hit.key === statKey(stat)) return hit.sha256;
  const h = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  const sha256 = h.digest("hex");
  hashCache.set(file, { key: statKey(stat), sha256 });
  return sha256;
}

/** Never throws. */
export async function inspectSlot(slot: SlotName, packagePath: string): Promise<SlotInspection> {
  const versionPath = path.join(path.dirname(packagePath), "version.json");
  const out: SlotInspection = {
    slot, packagePath, versionPath, state: "absent", problem: null,
    version: null, parsed: null, declaredSha256: null, sha256: null, sizeBytes: null, modifiedAt: null,
  };
  const problem = (text: string): SlotInspection => ({ ...out, state: "problem", problem: text });

  let stat: FileStat | null = null;
  try {
    const s: FileStat = await fs.promises.stat(packagePath) as any;
    if (s.isFile()) stat = s;
  } catch { /* absent */ }

  let versionText: string | null = null;
  let versionError: string | null = null;
  try {
    // The BOM is tolerated in case the file was ever rewritten by a Windows tool.
    versionText = String(await fs.promises.readFile(versionPath, "utf8")).replace(/^﻿/, "");
  } catch (e: any) {
    if (e?.code !== "ENOENT") versionError = String(e?.code ?? e?.message ?? "unreadable");
  }

  if (!stat && versionText === null && !versionError) return out;
  if (stat) {
    out.sizeBytes = stat.size;
    out.modifiedAt = stat.mtime;
  }
  if (!stat) return problem("version.json is there but the package file is missing (a copy in progress?).");
  if (versionError) return problem(`version.json cannot be read (${versionError}).`);
  if (versionText === null) return problem("The package is there but version.json is missing (a copy in progress, or a build that predates self-update).");

  let parsedJson: any;
  try {
    parsedJson = JSON.parse(versionText);
  } catch {
    return problem("version.json is not valid JSON (a copy in progress?).");
  }
  if (typeof parsedJson?.version !== "string" || typeof parsedJson?.sha256 !== "string") return problem("version.json does not hold a version and a sha256.");
  out.version = parsedJson.version.trim();
  out.declaredSha256 = parsedJson.sha256.trim().toLowerCase();
  out.parsed = parseAgentVersion(out.version);
  try {
    out.sha256 = await sha256OfFile(packagePath, stat);
  } catch {
    return problem("The package file cannot be read.");
  }
  if (out.declaredSha256 !== out.sha256) return problem("version.json does not match the package on disk (a copy in progress?).");
  if (!out.parsed) return problem("version.json holds a version that does not look like 1.2.3.");
  return { ...out, state: "valid" };
}

export type ValidSlot = SlotInspection & { state: "valid"; version: string; parsed: number[]; sha256: string; sizeBytes: number };
export const isValid = (s: SlotInspection | null | undefined): s is ValidSlot => !!s && s.state === "valid";

/* ------------------------------------------------------------------ the offer rule */

/** A candidate counts only when it is strictly newer than what is stable (no usable stable means any usable candidate counts). */
export function candidateIsUsable(stable: SlotInspection | null, candidate: SlotInspection | null): candidate is ValidSlot {
  if (!isValid(candidate)) return false;
  if (!isValid(stable)) return true;
  return compareAgentVersions(candidate.parsed, stable.parsed) > 0;
}

/**
 * The package a device in this ring may be given: a PILOT device the candidate when there is a usable one, otherwise the stable one;
 * a STABLE device only ever the stable one. (Whether it is newer than what the device runs is a separate question, see decideOffer.)
 */
export function eligiblePackage(ring: Ring, stable: SlotInspection | null, candidate: SlotInspection | null): { slot: "stable" | "candidate"; pkg: ValidSlot } | null {
  if (ring === "pilot" && candidateIsUsable(stable, candidate)) return { slot: "candidate", pkg: candidate };
  if (isValid(stable)) return { slot: "stable", pkg: stable };
  return null;
}

/** What to offer an agent that runs `reported`: the eligible package when strictly newer (agents never go down), else nothing. */
export function decideOffer(ring: Ring, reported: number[], stable: SlotInspection | null, candidate: SlotInspection | null): { slot: "stable" | "candidate"; pkg: ValidSlot } | null {
  const e = eligiblePackage(ring, stable, candidate);
  if (!e) return null;
  return compareAgentVersions(e.pkg.parsed, reported) > 0 ? e : null;
}

/* ------------------------------------------------------------------ file operations */

export type ReleaseErrorCode = "no_candidate" | "candidate_invalid" | "version_changed" | "not_newer" | "previous_failed" | "copy_failed" | "verify_failed";

export class ReleaseOpError extends Error {
  constructor(readonly code: ReleaseErrorCode, message: string) {
    super(message);
  }
}

/** Test hooks: throw from one to simulate a failure at that point. */
export type PromoteHooks = {
  afterPrevious?: () => void | Promise<void>;
  afterPackage?: () => void | Promise<void>;
  afterVersion?: () => void | Promise<void>;
};

async function renameRetry(from: string, to: string): Promise<void> {
  // On Windows a file somebody is reading cannot be replaced for a moment; elsewhere this succeeds at once.
  for (let i = 0; ; i++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (e: any) {
      if (i >= 8 || !["EPERM", "EBUSY", "EACCES"].includes(e?.code)) throw e;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}

const tmpName = (dest: string) => `${dest}.${randomBytes(4).toString("hex")}.tmp`;

/** Copies to a temporary file next to the destination, checks the hash of what was written, then renames over the destination. */
async function copyAtomic(src: string, dest: string, expectedSha256: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const tmp = tmpName(dest);
  try {
    await fs.promises.copyFile(src, tmp);
    const written = await sha256OfFile(tmp, (await fs.promises.stat(tmp)) as any);
    if (written !== expectedSha256) throw new Error("the copy does not match the original");
    try { const fd = await fs.promises.open(tmp, "r+"); try { await fd.sync(); } finally { await fd.close(); } } catch { /* best effort */ }
    await renameRetry(tmp, dest);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => { });
    throw e;
  } finally {
    hashCache.delete(tmp);
  }
}

async function writeAtomic(dest: string, data: Buffer | string): Promise<void> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const tmp = tmpName(dest);
  try {
    await fs.promises.writeFile(tmp, data);
    await renameRetry(tmp, dest);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => { });
    throw e;
  }
}

export type PromoteInput = {
  stablePath: string;
  candidatePath: string;
  previousPath: string;
  /** The candidate version the person saw; refused when the candidate on disk is a different one. */
  expectedVersion: string;
  hooks?: PromoteHooks;
};

export type PromoteResult = {
  version: string;
  sha256: string;
  previousVersion: string | null;
  /** False only when removing the candidate folder's files failed after a successful promotion (harmless: it is then not newer than stable). */
  candidateRemoved: boolean;
};

/**
 * Candidate becomes stable. Order: the old stable is copied to the previous slot (package, then version.json), the candidate package is
 * copied into the stable slot through a temporary file (hash checked before the rename), version.json is written LAST through a temporary
 * file, the stable slot is inspected again (hash and version must match), then the candidate is removed. Any failure before the end puts
 * the old stable back and leaves the candidate where it was.
 */
export async function promoteCandidate(input: PromoteInput): Promise<PromoteResult> {
  const { stablePath, candidatePath, previousPath, hooks } = input;
  const cand = await inspectSlot("candidate", candidatePath);
  if (cand.state === "absent") throw new ReleaseOpError("no_candidate", "There is no candidate build on the server.");
  if (!isValid(cand)) throw new ReleaseOpError("candidate_invalid", `The candidate build cannot be promoted: ${cand.problem}`);
  if (cand.version !== String(input.expectedVersion ?? "").trim()) {
    throw new ReleaseOpError("version_changed", `The candidate changed since you looked: it is now ${cand.version}, you saw ${String(input.expectedVersion ?? "").trim() || "no version"}.`);
  }
  const stable = await inspectSlot("stable", stablePath);
  if (isValid(stable) && compareAgentVersions(cand.parsed, stable.parsed) <= 0) {
    throw new ReleaseOpError("not_newer", `The candidate (${cand.version}) is not newer than the stable build (${stable.version}).`);
  }
  // The candidate's own version.json, kept byte for byte.
  const candVersionBytes = await fs.promises.readFile(cand.versionPath);

  const previousVersionPath = path.join(path.dirname(previousPath), "version.json");
  let previousVersion: string | null = null;
  const hadStable = isValid(stable);

  // 1. Keep the old stable as "previous" (package first, version.json last).
  if (isValid(stable)) {
    try {
      await copyAtomic(stable.packagePath, previousPath, stable.sha256);
      await writeAtomic(previousVersionPath, await fs.promises.readFile(stable.versionPath));
      previousVersion = stable.version;
      await hooks?.afterPrevious?.();
    } catch (e: any) {
      throw new ReleaseOpError("previous_failed", `Could not keep the current stable build as previous: ${e?.message ?? e}. Nothing was changed.`);
    }
  }

  const restore = async () => {
    if (!hadStable) return;
    try {
      await copyAtomic(previousPath, stablePath, (stable as ValidSlot).sha256);
      await writeAtomic(stable.versionPath, await fs.promises.readFile(previousVersionPath));
    } catch { /* the caller reports the original error */ }
  };

  try {
    // 2. The package, then 3. version.json last: until it lands, the new package does not match the old version.json and is not offered.
    await copyAtomic(cand.packagePath, stablePath, cand.sha256);
    await hooks?.afterPackage?.();
    await writeAtomic(stable.versionPath, candVersionBytes);
    await hooks?.afterVersion?.();
  } catch (e: any) {
    await restore();
    throw new ReleaseOpError("copy_failed", `Could not copy the candidate into the stable slot: ${e?.message ?? e}. ${hadStable ? "The previous stable build was put back." : ""}`.trim());
  }

  // 4. Verify what is now stable.
  const after = await inspectSlot("stable", stablePath);
  if (!isValid(after) || after.sha256 !== cand.sha256 || after.version !== cand.version) {
    await restore();
    throw new ReleaseOpError("verify_failed", `The stable slot does not hold the candidate after copying (${isValid(after) ? "different content" : after.problem ?? "nothing there"}). ${hadStable ? "The previous stable build was put back." : ""}`.trim());
  }

  // 5. The candidate is done: version.json first so it can never look half-valid, then the package.
  const candidateRemoved = await removeSlotFiles(cand.packagePath);
  return { version: cand.version, sha256: cand.sha256, previousVersion, candidateRemoved };
}

/** Deletes version.json first, then the package. Returns false when something could not be removed. */
export async function removeSlotFiles(packagePath: string): Promise<boolean> {
  let ok = true;
  for (const file of [path.join(path.dirname(packagePath), "version.json"), packagePath]) {
    try {
      await fs.promises.rm(file, { force: true });
    } catch {
      ok = false;
    }
  }
  hashCache.delete(packagePath);
  return ok;
}

export type WithdrawResult = { version: string | null; removed: boolean };

/** Deletes the candidate (also a broken one), when it is the version the person saw (if they said one). */
export async function withdrawCandidate(candidatePath: string, expectedVersion?: string | null): Promise<WithdrawResult> {
  const cand = await inspectSlot("candidate", candidatePath);
  if (cand.state === "absent") throw new ReleaseOpError("no_candidate", "There is no candidate build on the server.");
  const expected = String(expectedVersion ?? "").trim();
  if (expected && cand.version !== expected) {
    throw new ReleaseOpError("version_changed", `The candidate changed since you looked: it is now ${cand.version ?? "unreadable"}, you saw ${expected}.`);
  }
  const removed = await removeSlotFiles(candidatePath);
  if (!removed) throw new ReleaseOpError("copy_failed", "The candidate files could not all be removed.");
  return { version: cand.version, removed };
}

/* ------------------------------------------------------------------ health gate */

export const ONLINE_WINDOW_MS = 15 * 60_000;
export const OFFLINE_SINCE_UPDATE_MS = 30 * 60_000;
/** A device that checks in this long after its version changed has been seen online after updating. */
export const POST_UPDATE_CONFIRM_MS = 2 * 60_000;

export type GateDevice = {
  /** Effective ring, already resolved. */
  ring: Ring;
  version: string | null;
  lastCheckInAt: Date | null;
  versionChangedAt: Date | null;
  /** The device's latest "update the agent" job within the last day failed. */
  updateJobFailed?: boolean;
};

export type GateStatus = "no_candidate" | "no_pilot_devices" | "not_updated_yet" | "offline_since_update" | "just_updated" | "healthy";

export type Gate = {
  candidateVersion: string | null;
  pilotTotal: number;
  /** Pilot devices that run exactly the candidate version. */
  onCandidate: number;
  /** ...of those, checked in within the last 15 minutes. */
  onCandidateOnline: number;
  /** ...of those, seen online after updating (checked in at least 2 minutes after the version changed; unknown update time counts when online). */
  seenOnlineAfterUpdate: number;
  /** Pilot devices that are not on the candidate version yet. */
  notYetUpdated: number;
  /** Pilot devices that updated to the candidate and have not checked in for more than 30 minutes. */
  offlineSinceUpdating: number;
  /** Pilot devices not on the candidate whose last update job failed. */
  updateFailed: number;
  status: GateStatus;
  /** Plain language for the admin. */
  message: string;
  /** Reasons promoting needs force + a reason; empty when it does not. */
  blockers: string[];
};

export function computeGate(candidateVersion: string | null, devices: GateDevice[], now: Date = new Date()): Gate {
  const pilots = devices.filter((d) => d.ring === "pilot");
  const t = now.getTime();
  const g: Gate = {
    candidateVersion, pilotTotal: pilots.length, onCandidate: 0, onCandidateOnline: 0, seenOnlineAfterUpdate: 0,
    notYetUpdated: 0, offlineSinceUpdating: 0, updateFailed: 0, status: "no_candidate", message: "", blockers: [],
  };
  if (!candidateVersion) {
    g.message = "There is no candidate build on the server.";
    return g;
  }
  const want = parseAgentVersion(candidateVersion);
  for (const d of pilots) {
    const v = parseAgentVersion(d.version);
    const on = !!(want && v && compareAgentVersions(v, want) === 0);
    const last = d.lastCheckInAt ? d.lastCheckInAt.getTime() : null;
    if (!on) {
      g.notYetUpdated++;
      if (d.updateJobFailed) g.updateFailed++;
      continue;
    }
    g.onCandidate++;
    const online = last !== null && t - last <= ONLINE_WINDOW_MS;
    if (online) g.onCandidateOnline++;
    if (last !== null && t - last > OFFLINE_SINCE_UPDATE_MS) g.offlineSinceUpdating++;
    const changed = d.versionChangedAt ? d.versionChangedAt.getTime() : null;
    if (changed === null) {
      if (online) g.seenOnlineAfterUpdate++;
    } else if (last !== null && last - changed >= POST_UPDATE_CONFIRM_MS) {
      g.seenOnlineAfterUpdate++;
    }
  }
  if (g.pilotTotal === 0) {
    g.status = "no_pilot_devices";
    g.message = "No device is in the Pilot ring for this system, so this build has not been tried anywhere.";
    g.blockers.push("No pilot device runs the candidate build, so it has not been tried on a real device.");
  } else if (g.onCandidate === 0) {
    g.status = "not_updated_yet";
    g.message = "No pilot device has updated to the candidate yet.";
    g.blockers.push("No pilot device runs the candidate build yet.");
  } else if (g.offlineSinceUpdating > 0) {
    g.status = "offline_since_update";
    g.message = `${g.offlineSinceUpdating} pilot ${g.offlineSinceUpdating === 1 ? "device updated and has not been seen for over 30 minutes" : "devices updated and have not been seen for over 30 minutes"}. The new build may have broken it.`;
    g.blockers.push(`${g.offlineSinceUpdating} pilot ${g.offlineSinceUpdating === 1 ? "device has" : "devices have"} not checked in for over 30 minutes since updating.`);
  } else if (g.seenOnlineAfterUpdate === 0) {
    g.status = "just_updated";
    g.message = "A pilot device updated but has not been seen online after updating yet. Give it a few minutes.";
  } else {
    g.status = "healthy";
    g.message = `${g.seenOnlineAfterUpdate} of ${g.pilotTotal} pilot ${g.pilotTotal === 1 ? "device was" : "devices were"} seen online after updating to the candidate.`;
  }
  return g;
}

/* ------------------------------------------------------------------ promote request rules */

export type PromoteDecision =
  | { allow: true; forced: boolean; reason: string | null }
  | { allow: false; status: 400 | 409; code: "no_candidate" | "candidate_invalid" | "version_changed" | "not_newer" | "force_required" | "reason_required" | "reason_invalid"; message: string; blockers?: string[] };

export function cleanReason(raw: unknown): { ok: true; text: string } | { ok: false; code: "reason_required" | "reason_invalid"; message: string } {
  const text = String(raw ?? "").trim();
  if (text.length < 5) return { ok: false, code: "reason_required", message: "Promoting without a healthy pilot needs a reason (at least a few words)." };
  if (text.length > 300) return { ok: false, code: "reason_invalid", message: "The reason is too long (300 characters at most)." };
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return { ok: false, code: "reason_invalid", message: "The reason has characters that are not allowed." };
  return { ok: true, text };
}

/** The rules a promote request must pass, apart from the right to do it (checked by the route). */
export function decidePromote(input: {
  requestedVersion: unknown;
  candidate: SlotInspection | null;
  stable: SlotInspection | null;
  gate: Gate;
  force: unknown;
  reason: unknown;
}): PromoteDecision {
  const { candidate, stable, gate } = input;
  if (!candidate || candidate.state === "absent") return { allow: false, status: 409, code: "no_candidate", message: "There is no candidate build to promote." };
  const seen = String(input.requestedVersion ?? "").trim();
  if (!isValid(candidate)) return { allow: false, status: 409, code: "candidate_invalid", message: `The candidate build cannot be promoted: ${candidate.problem}` };
  if (candidate.version !== seen) {
    return { allow: false, status: 409, code: "version_changed", message: `The candidate changed since you looked (now ${candidate.version ?? "unreadable"}, you saw ${seen || "no version"}). Look again before promoting.` };
  }
  if (isValid(stable) && compareAgentVersions(candidate.parsed, stable.parsed) <= 0) {
    return { allow: false, status: 409, code: "not_newer", message: `The candidate (${candidate.version}) is not newer than the stable build (${stable.version}).` };
  }
  if (gate.blockers.length === 0) return { allow: true, forced: false, reason: null };
  if (input.force !== true) {
    return { allow: false, status: 409, code: "force_required", message: "The pilot ring does not look healthy. Promoting anyway needs force and a reason.", blockers: gate.blockers };
  }
  const r = cleanReason(input.reason);
  if (!r.ok) return { allow: false, status: 400, code: r.code, message: r.message, blockers: gate.blockers };
  return { allow: true, forced: true, reason: r.text };
}
