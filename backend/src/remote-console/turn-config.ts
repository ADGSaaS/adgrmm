// backend/src/remote-console/turn-config.ts
//
// Where Remote Console gets its relay. See docs/remote-console-turn.md.
import { createHmac } from "node:crypto";

export type IceServer = { urls: string | string[]; username?: string; credential?: string };
export type TurnProvider = "builtin" | "cloudflare" | "none";

const DEFAULT_STUN_URLS = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"];

// Long enough for a long support session. Credentials are issued per session.
export const TURN_CREDENTIAL_TTL_SEC = 8 * 60 * 60;

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function stunServers(env: NodeJS.ProcessEnv = process.env): IceServer[] {
  const urls = list(env.TURN_STUN_URLS);
  return [{ urls: urls.length ? urls : DEFAULT_STUN_URLS }];
}

/** TURN_PROVIDER wins. Without it, the provider follows whichever settings are present. */
export function resolveTurnProvider(env: NodeJS.ProcessEnv = process.env): TurnProvider {
  const chosen = (env.TURN_PROVIDER ?? "").trim().toLowerCase();
  if (chosen === "builtin" || chosen === "cloudflare" || chosen === "none") return chosen;
  if (chosen) throw new Error(`TURN_PROVIDER must be builtin, cloudflare or none, not "${chosen}".`);

  if (env.CLOUDFLARE_TURN_KEY_ID?.trim() && env.CLOUDFLARE_TURN_API_TOKEN?.trim()) return "cloudflare";
  if (list(env.TURN_URLS).length && env.TURN_AUTH_SECRET?.trim()) return "builtin";
  return "none";
}

/** Time-limited credentials in the format coturn checks when it runs with use-auth-secret. */
export function builtinIceServers(env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): IceServer[] {
  const urls = list(env.TURN_URLS);
  const secret = env.TURN_AUTH_SECRET?.trim();
  if (!urls.length || !secret) {
    throw new Error("The builtin TURN provider needs TURN_URLS and TURN_AUTH_SECRET.");
  }

  const username = `${Math.floor(nowMs / 1000) + TURN_CREDENTIAL_TTL_SEC}:adgrmm`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return [...stunServers(env), { urls, username, credential }];
}
