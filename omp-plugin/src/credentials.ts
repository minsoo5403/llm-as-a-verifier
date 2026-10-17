/**
 * Read the upstream credential out of OMP's own credential store.
 *
 * The host's `getApiKey` is bound to the provider being called, so it cannot
 * hand the proxy a key for a *different* provider; and passing the proxy's own
 * `apiKey` through makes the upstream answer "Invalid credential". Reading the
 * store directly keeps candidate generation on the upstream's real credential
 * without duplicating the host's provider logic.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentConfigDir } from "./config";

const KEY_FIELDS = ["key", "apiKey", "api_key", "access_token", "accessToken"] as const;

function stringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object" || !(field in value)) return undefined;
  const found = Reflect.get(value, field);
  return typeof found === "string" && found.length > 0 ? found : undefined;
}

/** Environment variable named by config, then the store's newest active credential. */
export function upstreamCredential(provider: string, apiKeyEnv: string): string | undefined {
  const fromEnv = process.env[apiKeyEnv];
  if (fromEnv) return fromEnv;

  const dbPath = join(agentConfigDir(), "agent.db");
  if (!existsSync(dbPath)) return undefined;

  let data: string | undefined;
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query(
        "select data from auth_credentials " +
          "where provider = ? and disabled_cause is null order by id desc limit 1",
      )
      .get(provider);
    if (row && typeof row === "object" && "data" in row) {
      const raw = Reflect.get(row, "data");
      if (typeof raw === "string") data = raw;
    }
  } finally {
    db.close();
  }
  if (!data) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return data.startsWith("sk-") ? data : undefined;
  }
  for (const field of KEY_FIELDS) {
    const value = stringField(parsed, field);
    if (value) return value;
  }
  return undefined;
}
