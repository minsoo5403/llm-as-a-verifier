/**
 * Bridge to the repository's Python verifier: one process per call.
 *
 * The verifier call dominates latency (3-8 s), so a persistent sidecar would
 * add lifecycle risk for no measurable gain.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const PLUGIN_DIR = (() => {
  try {
    return dirname(dirname(fileURLToPath(import.meta.url)));
  } catch {
    return dirname(process.cwd());
  }
})();

export type BridgeResponse = {
  ok: boolean;
  result?: Record<string, unknown>;
  usage?: Record<string, number>;
  error?: string;
  traceback?: string;
};

export function findBridge(): { bridge: string; repoRoot: string } {
  const envRoot = process.env.LLM_VERIFIER_ROOT;
  const candidates: Array<{ bridge: string; repoRoot: string }> = [];
  if (envRoot) {
    candidates.push({
      bridge: join(envRoot, "omp-plugin", "python", "omp_bridge.py"),
      repoRoot: envRoot,
    });
  }
  candidates.push({
    bridge: join(PLUGIN_DIR, "python", "omp_bridge.py"),
    repoRoot: dirname(PLUGIN_DIR),
  });
  for (const c of candidates) if (existsSync(c.bridge)) return c;
  return candidates[candidates.length - 1];
}

export function resolvePython(repoRoot: string): string {
  const fromEnv = process.env.LLM_VERIFIER_PYTHON;
  if (fromEnv) return fromEnv;
  const candidates =
    process.platform === "win32"
      ? [join(repoRoot, ".venv", "Scripts", "python.exe")]
      : [join(repoRoot, ".venv", "bin", "python3"), join(repoRoot, ".venv", "bin", "python")];
  for (const c of candidates) if (existsSync(c)) return c;
  return process.platform === "win32" ? "python" : "python3";
}

export type BridgeCallOptions = {
  signal?: AbortSignal;
  /** Verifier model override; null uses the bridge's environment default. */
  model?: string | null;
  /** Reasoning effort for a DeepSeek backend. */
  effort?: string | null;
};

export async function callBridge(
  pi: ExtensionAPI,
  command: string,
  params: Record<string, unknown>,
  options: BridgeCallOptions = {},
): Promise<BridgeResponse> {
  const { bridge, repoRoot } = findBridge();
  if (!existsSync(bridge)) {
    throw new Error(
      `omp_bridge.py not found at ${bridge}; set LLM_VERIFIER_ROOT to the ` +
        `llm-as-a-verifier checkout.`,
    );
  }
  const python = resolvePython(repoRoot);
  const dir = mkdtempSync(join(tmpdir(), "llmver-"));
  const reqPath = join(dir, "request.json");
  try {
    writeFileSync(
      reqPath,
      JSON.stringify({
        command,
        params: { ...params, model: options.model ?? undefined, effort: options.effort ?? undefined },
      }),
      "utf8",
    );
    const res = await pi.exec(python, [bridge, reqPath, "--root", repoRoot], {
      signal: options.signal,
      cwd: repoRoot,
    });
    if (res.killed) throw new Error("verifier call cancelled");
    const start = (res.stdout ?? "").indexOf("{");
    const end = (res.stdout ?? "").lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error(
        `verifier bridge produced no JSON (exit ${res.code})\n` +
          `stderr: ${(res.stderr ?? "").slice(0, 600)}`,
      );
    }
    const payload = JSON.parse(res.stdout.slice(start, end + 1)) as BridgeResponse;
    if (!payload.ok) throw new Error(payload.error ?? "verifier bridge failed");
    return payload;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function usageLine(usage?: Record<string, number>): string {
  if (!usage) return "";
  const hit = usage.cache_hit_rate ? ` cache ${(usage.cache_hit_rate * 100).toFixed(0)}%` : "";
  return `\nverifier calls ${usage.calls}, in ${usage.input_tokens}, out ${usage.output_tokens}${hit}`;
}
