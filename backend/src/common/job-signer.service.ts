// backend/src/common/job-signer.service.ts
import { Injectable, Logger } from "@nestjs/common";
import { constants, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type SignedEnvelope = { payload: string; sig: string };

export type SessionKind = "console" | "shell" | "desktop";

/**
 * Signs everything an agent is told to run. Agents receive the public key at enrollment and
 * refuse anything unsigned, so someone who can tamper with traffic or the job queue, but does
 * not hold this key, cannot run commands on a device.
 *
 * Losing the key file means every agent must run the installer again.
 */
@Injectable()
export class JobSignerService {
  private readonly log = new Logger("JobSigner");
  private privateKey: KeyObject | null = null;
  private publicPem = "";

  private keyPath(): string {
    return process.env.JOB_SIGNING_KEY_FILE
      ? path.resolve(process.env.JOB_SIGNING_KEY_FILE)
      : path.join(process.cwd(), ".secrets", "job-signing.pem");
  }

  private load(): KeyObject {
    if (this.privateKey) return this.privateKey;

    const file = this.keyPath();
    let pem: string;
    try {
      pem = fs.readFileSync(file, "utf8");
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
      pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // "wx" fails if another process created the key first, rather than replacing it.
      fs.writeFileSync(file, pem, { mode: 0o600, flag: "wx" });
      this.log.log(`Created a job signing key at ${file}`);
    }

    this.privateKey = createPrivateKey(pem);
    this.publicPem = createPublicKey(this.privateKey).export({ type: "spki", format: "pem" }) as string;
    return this.privateKey;
  }

  publicKeyPem(): string {
    this.load();
    return this.publicPem;
  }

  /** Wraps the contents for one agent. The agent parses only the bytes that were signed. */
  seal(agentId: string, contents: Record<string, unknown>): SignedEnvelope {
    const bytes = Buffer.from(JSON.stringify({ ...contents, agentId, iat: Date.now() }), "utf8");
    const sig = sign("sha256", bytes, {
      key: this.load(),
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    });
    return { payload: bytes.toString("base64"), sig: sig.toString("base64") };
  }

  /**
   * The field to add to a message that starts a remote session. It is bound to one agent, one kind
   * of session and one session id, along with any choice the agent acts on, such as who a shell runs as.
   *
   * The nonce, not the session id, is what the agent remembers, because the same session is
   * announced again when an agent reconnects while it is being set up.
   *
   * Agents without session signing still work when the key cannot be read, and agents that have it
   * refuse the start, so a signing failure is logged here rather than failing the request.
   */
  sessionStartField(
    agentId: string,
    kind: SessionKind,
    sessionId: string,
    bound: Record<string, unknown> = {},
  ): { signed?: SignedEnvelope } {
    try {
      return { signed: this.seal(agentId, { ...bound, t: "session_start", kind, sessionId, nonce: randomUUID() }) };
    } catch (e: any) {
      this.log.error(`Could not sign a ${kind} session start: ${e?.message ?? e}`);
      return {};
    }
  }

  /** Signs text the agent can rebuild itself, such as an update manifest's canonical form. */
  signBlob(canonical: string): string {
    return sign("sha256", Buffer.from(canonical, "utf8"), {
      key: this.load(),
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }).toString("base64");
  }
}
