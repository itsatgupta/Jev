import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/**
 * Bring-your-own-key support. A visitor's keys arrive as request headers and live only for the duration of
 * that request (AsyncLocalStorage), so concurrent visitors can never see or spend each other's keys.
 * Keys are never written to disk, never logged, and never echoed back to the browser.
 */
export type KeyName = "jev" | "claude" | "kimi";
export type UserKeys = Partial<Record<KeyName, string>>;

const store = new AsyncLocalStorage<UserKeys>();
export const withKeys = <T>(keys: UserKeys, fn: () => T): T => store.run(keys, fn);
export const currentUserKeys = (): UserKeys => store.getStore() ?? {};

const ENV_VAR: Record<KeyName, string> = { jev: "TYPESAFE_API_KEY", claude: "ANTHROPIC_API_KEY", kimi: "MOONSHOT_API_KEY" };
export const HEADER: Record<KeyName, string> = { jev: "x-jev-key", claude: "x-claude-key", kimi: "x-kimi-key" };

/**
 * Hosted mode (HOSTED=1): ignore the server's own keys entirely, so a public deployment can never spend
 * the owner's money. Every visitor must bring their own keys; without them the demos run simulated.
 */
export const hosted = () => /^(1|true|yes)$/i.test(process.env.HOSTED ?? "");

/** A key is only accepted if it looks like a real API key: printable ASCII, no spaces, sane length. */
export const validKey = (v: unknown): v is string => typeof v === "string" && /^[\x21-\x7E]{8,400}$/.test(v);

export function keyFor(name: KeyName): string | undefined {
  const user = store.getStore()?.[name];
  if (user) return user;
  return hosted() ? undefined : process.env[ENV_VAR[name]]?.trim() || undefined;
}

export const keySource = (name: KeyName): "you" | "server" | "none" =>
  store.getStore()?.[name] ? "you" : keyFor(name) ? "server" : "none";

/** Stable, non-reversible id for a key, used to give each visitor's key its own budget. */
const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

/** Budget/availability bucket: all server-key traffic shares "server"; each user key gets its own. */
export const bucket = (name: KeyName): string => {
  const user = store.getStore()?.[name];
  return user ? `u:${fingerprint(user)}` : "server";
};

/** Replace any of the current request's keys in a string, so an upstream error can never echo one back. */
export function redact(message: string): string {
  let out = message;
  for (const k of Object.values(store.getStore() ?? {})) if (k) out = out.split(k).join("[your key]");
  return out;
}
