/**
 * Plugin configuration: defaults < user file < project file < environment.
 *
 *   user     <agent dir>/llm-verifier.json      (default ~/.omp/agent)
 *   project  <cwd>/.omp/llm-verifier.json
 *
 * Every route defaults to OFF except the passive tools, so an installed
 * plugin never spends verifier tokens on its own until the operator turns a
 * route on with `/verifier`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type VerifierConfig = {
  verifier: { model: string | null; effort: string };
  gate: {
    enabled: boolean;
    min_score: number;
    max_continuations: number;
    n_evaluations: number;
  };
  context: {
    enabled: boolean;
    tools: string[];
    min_output_chars: number;
    max_calls_per_turn: number;
    /** Inject the score only while the verifier judges the task incomplete. */
    min_score: number;
  };
  proxy: {
    enabled: boolean;
    /** "provider/model" used to generate candidates; the proxy itself is never used. */
    upstream: string | null;
    base_url: string | null;
    model: string | null;
    api_key_env: string;
    candidates: number;
    pivots: number;
    n_evaluations: number;
  };
};

export const DEFAULT_CONFIG: VerifierConfig = {
  verifier: { model: null, effort: "high" },
  gate: { enabled: false, min_score: 0.5, max_continuations: 2, n_evaluations: 1 },
  context: {
    enabled: false,
    tools: ["bash"],
    min_output_chars: 400,
    max_calls_per_turn: 2,
    min_score: 0.5,
  },
  proxy: {
    enabled: false,
    upstream: null,
    base_url: null,
    model: null,
    api_key_env: "DEEPSEEK_API_KEY",
    candidates: 3,
    pivots: 2,
    n_evaluations: 1,
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function pickString(value: unknown, fallback: string | null): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function pickStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  return out.length > 0 ? out.map((v) => v.trim()) : fallback;
}

/** Coerce arbitrary parsed JSON into a complete, valid config. */
export function normalizeConfig(raw: unknown, base: VerifierConfig = DEFAULT_CONFIG): VerifierConfig {
  const root = asRecord(raw);
  const verifier = asRecord(root.verifier);
  const gate = asRecord(root.gate);
  const context = asRecord(root.context);
  const proxy = asRecord(root.proxy);
  return {
    verifier: {
      model: pickString(verifier.model, base.verifier.model),
      effort: pickString(verifier.effort, base.verifier.effort) ?? base.verifier.effort,
    },
    gate: {
      enabled: pickBool(gate.enabled, base.gate.enabled),
      min_score: pickNumber(gate.min_score, base.gate.min_score, 0, 1),
      max_continuations: pickNumber(
        gate.max_continuations,
        base.gate.max_continuations,
        0,
        8,
      ),
      n_evaluations: pickNumber(gate.n_evaluations, base.gate.n_evaluations, 1, 16),
    },
    context: {
      enabled: pickBool(context.enabled, base.context.enabled),
      tools: pickStringArray(context.tools, base.context.tools),
      min_output_chars: pickNumber(
        context.min_output_chars,
        base.context.min_output_chars,
        0,
        1_000_000,
      ),
      max_calls_per_turn: pickNumber(
        context.max_calls_per_turn,
        base.context.max_calls_per_turn,
        0,
        32,
      ),
      min_score: pickNumber(context.min_score, base.context.min_score, 0, 1),
    },
    proxy: {
      enabled: pickBool(proxy.enabled, base.proxy.enabled),
      upstream: pickString(proxy.upstream, base.proxy.upstream),
      base_url: pickString(proxy.base_url, base.proxy.base_url),
      model: pickString(proxy.model, base.proxy.model),
      api_key_env: pickString(proxy.api_key_env, base.proxy.api_key_env) ?? base.proxy.api_key_env,
      candidates: pickNumber(proxy.candidates, base.proxy.candidates, 2, 8),
      pivots: pickNumber(proxy.pivots, base.proxy.pivots, 1, 8),
      n_evaluations: pickNumber(proxy.n_evaluations, base.proxy.n_evaluations, 1, 16),
    },
  };
}

function envBoolean(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "on";
}

function applyEnv(config: VerifierConfig): VerifierConfig {
  const out = structuredClone(config);
  const gate = envBoolean("LLM_VERIFIER_GATE");
  if (gate !== undefined) out.gate.enabled = gate;
  const context = envBoolean("LLM_VERIFIER_CONTEXT");
  if (context !== undefined) out.context.enabled = context;
  const proxy = envBoolean("LLM_VERIFIER_PROXY");
  if (proxy !== undefined) out.proxy.enabled = proxy;
  const model = pickString(process.env.LLM_VERIFIER_MODEL, null);
  if (model) out.verifier.model = model;
  const effort = pickString(process.env.LLM_VERIFIER_EFFORT, null);
  if (effort) out.verifier.effort = effort;
  const tools = pickStringArray(
    process.env.LLM_VERIFIER_CONTEXT_TOOLS?.split(",").map((t) => t.trim()),
    [],
  );
  if (tools.length > 0) out.context.tools = tools;
  return out;
}

export function agentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".omp", "agent");
}

export function configPaths(cwd: string): { user: string; project: string } {
  return {
    user: join(agentConfigDir(), "llm-verifier.json"),
    project: join(cwd, ".omp", "llm-verifier.json"),
  };
}

function readLayer(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function loadConfig(cwd: string): { config: VerifierConfig; userPath: string; projectPath: string } {
  const paths = configPaths(cwd);
  const user = readLayer(paths.user);
  const project = readLayer(paths.project);
  let config = DEFAULT_CONFIG;
  if (user !== undefined) config = normalizeConfig(user, config);
  if (project !== undefined) config = normalizeConfig(project, config);
  return { config: applyEnv(config), userPath: paths.user, projectPath: paths.project };
}

/** Patch the user-level config file, preserving keys this plugin does not own. */
export function patchUserConfig(cwd: string, patch: Record<string, unknown>): string {
  const { userPath } = configPaths(cwd);
  const existing = asRecord(readLayer(userPath));
  const merged: Record<string, unknown> = { ...existing };
  for (const [section, values] of Object.entries(patch)) {
    if (values === undefined) continue;
    merged[section] = { ...asRecord(existing[section]), ...asRecord(values) };
  }
  mkdirSync(dirname(userPath), { recursive: true });
  writeFileSync(userPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return userPath;
}
