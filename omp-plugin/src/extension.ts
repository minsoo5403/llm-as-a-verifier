/**
 * OMP extension: LLM-as-a-Verifier tools.
 *
 * Exposes the `llm_verifier` package (fine-grained logprob reward +
 * Probabilistic Pivot Tournament) to the agent as always-available tools.
 * The verifier itself runs in the repository's own Python environment; this
 * module only marshals one JSON request per tool call through
 * `python/omp_bridge.py`, so no verifier logic is duplicated in TypeScript.
 *
 * Environment:
 *   LLM_VERIFIER_ROOT    repository root (default: the plugin's parent dir)
 *   LLM_VERIFIER_PYTHON  interpreter to run the bridge with (default: the
 *                        repo's .venv, then python3/python on PATH)
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

function findBridge(): { bridge: string; repoRoot: string } {
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

function resolvePython(repoRoot: string): string {
  const fromEnv = process.env.LLM_VERIFIER_PYTHON;
  if (fromEnv) return fromEnv;
  const candidates =
    process.platform === "win32"
      ? [join(repoRoot, ".venv", "Scripts", "python.exe")]
      : [join(repoRoot, ".venv", "bin", "python3"), join(repoRoot, ".venv", "bin", "python")];
  for (const c of candidates) if (existsSync(c)) return c;
  return process.platform === "win32" ? "python" : "python3";
}

type BridgeResponse = {
  ok: boolean;
  result?: Record<string, unknown>;
  usage?: Record<string, number>;
  error?: string;
  traceback?: string;
};

function parseJson(text: string): BridgeResponse {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("bridge produced no JSON: " + text.slice(0, 400));
  }
  return JSON.parse(text.slice(start, end + 1)) as BridgeResponse;
}

async function callBridge(
  pi: ExtensionAPI,
  command: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<BridgeResponse> {
  const { bridge, repoRoot } = findBridge();
  if (!existsSync(bridge)) {
    throw new Error(
      `omp_bridge.py not found at ${bridge}. Set LLM_VERIFIER_ROOT to the ` +
        `llm-as-a-verifier checkout.`,
    );
  }
  const python = resolvePython(repoRoot);
  const dir = mkdtempSync(join(tmpdir(), "llmver-"));
  const reqPath = join(dir, "request.json");
  try {
    writeFileSync(reqPath, JSON.stringify({ command, params }), "utf8");
    const res = await pi.exec(python, [bridge, reqPath, "--root", repoRoot], {
      signal,
      cwd: repoRoot,
    });
    if (res.killed) throw new Error("verifier call cancelled");
    let payload: BridgeResponse;
    try {
      payload = parseJson(res.stdout ?? "");
    } catch (err) {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n` +
          `stderr: ${(res.stderr ?? "").slice(0, 600)}`,
      );
    }
    if (!payload.ok) {
      throw new Error(payload.error ?? "verifier bridge failed");
    }
    return payload;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function usageLine(usage?: Record<string, number>): string {
  if (!usage) return "";
  const hit = usage.cache_hit_rate ? ` cache ${(usage.cache_hit_rate * 100).toFixed(0)}%` : "";
  return `\nverifier calls ${usage.calls}, in ${usage.input_tokens}, out ${usage.output_tokens}${hit}`;
}

export default function llmVerifierExtension(pi: ExtensionAPI) {
  const z = pi.zod;

  pi.setLabel("LLM-as-a-Verifier");

  pi.on("session_start", async (_event, ctx) => {
    const { bridge } = findBridge();
    if (!existsSync(bridge)) {
      ctx.ui.notify(
        `llm-verifier: bridge missing at ${bridge} (set LLM_VERIFIER_ROOT)`,
        "warning",
      );
    }
  });

  pi.registerCommand("verifier", {
    description: "Report the llm-verifier bridge status and backend",
    handler: async (_args, ctx) => {
      const payload = await callBridge(pi, "ping", {});
      const r = payload.result ?? {};
      ctx.ui.notify(
        `llm-verifier ${r.version} | python ${r.python} | backend ${r.backend} | ` +
          `granularity ${r.granularity} | effort ${r.effort}`,
        "info",
      );
    },
  });

  pi.registerTool({
    name: "verify_compare",
    label: "Verify: compare two candidates",
    loadMode: "essential",
    defaultInactive: false,
    description:
      "Score two candidate answers/trajectories against a task with the " +
      "fine-grained logprob verifier and return both rewards in [0,1]. Use it " +
      "to judge which of two options is better, or to sanity-check a single " +
      "answer (compare it against a deliberately wrong variant).",
    parameters: z.object({
      problem: z.string(),
      candidate_a: z.string(),
      candidate_b: z.string(),
      criteria: z.array(z.string()),
      n_evaluations: z.number().optional(),
    }),
    async execute(_id, params, signal) {
      const payload = await callBridge(
        pi,
        "compare",
        {
          problem: params.problem,
          candidate_a: params.candidate_a,
          candidate_b: params.candidate_b,
          criteria: params.criteria,
          n_evaluations: params.n_evaluations ?? 1,
        },
        signal,
      );
      const r = payload.result as { reward_a: number; reward_b: number; prefers: string };
      return {
        content: [
          {
            type: "text",
            text:
              `reward_a=${r.reward_a.toFixed(5)} reward_b=${r.reward_b.toFixed(5)} ` +
              `-> prefers ${r.prefers}${usageLine(payload.usage)}`,
          },
        ],
        details: { ...r, usage: payload.usage },
      };
    },
  });

  pi.registerTool({
    name: "verify_select",
    label: "Verify: best of N",
    loadMode: "essential",
    defaultInactive: false,
    description:
      "Rank N candidate answers/trajectories for one task with the " +
      "Probabilistic Pivot Tournament (O(Nk) verifier comparisons) and return " +
      "the winner plus every candidate's score. Use it to pick the best of " +
      "several drafts instead of eyeballing them.",
    parameters: z.object({
      problem: z.string(),
      candidates: z.array(z.string()),
      criteria: z.array(z.string()),
      pivots: z.number().optional(),
      n_evaluations: z.number().optional(),
      seed: z.number().optional(),
    }),
    async execute(_id, params, signal) {
      if (params.candidates.length < 2) {
        throw new Error("verify_select needs at least 2 candidates");
      }
      const payload = await callBridge(
        pi,
        "select",
        {
          problem: params.problem,
          candidates: params.candidates,
          criteria: params.criteria,
          pivots: params.pivots ?? 2,
          n_evaluations: params.n_evaluations ?? 1,
          seed: params.seed ?? 0,
        },
        signal,
      );
      const r = payload.result as {
        index: number;
        scores: number[];
        n_comparisons: number;
        best: string;
      };
      const table = r.scores
        .map((s, i) => `  [${i}] ${s.toFixed(4)}${i === r.index ? "  <- selected" : ""}`)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text:
              `selected candidate ${r.index} after ${r.n_comparisons} comparisons\n` +
              `${table}\n\nwinner:\n${r.best}${usageLine(payload.usage)}`,
          },
        ],
        details: { ...r, usage: payload.usage },
      };
    },
  });

  pi.registerTool({
    name: "verify_progress",
    label: "Verify: progress curve",
    loadMode: "essential",
    defaultInactive: false,
    description:
      "Score how far a finished trajectory got after each step, from the " +
      "verifier's logprob expectation (1 = certainly incomplete, 20 = verified " +
      "complete). Use it to find the step where a run stopped making progress.",
    parameters: z.object({
      problem: z.string(),
      steps: z.array(z.string()),
      n_evaluations: z.number().optional(),
    }),
    async execute(_id, params, signal) {
      const payload = await callBridge(
        pi,
        "track",
        {
          problem: params.problem,
          steps: params.steps,
          n_evaluations: params.n_evaluations ?? 1,
        },
        signal,
      );
      const r = payload.result as {
        checkpoint_steps: number[];
        scores: number[];
        final: number;
      };
      const curve = r.scores
        .map((s, i) => `  step ${r.checkpoint_steps[i]}: ${s.toFixed(4)}`)
        .join("\n");
      return {
        content: [
          { type: "text", text: `progress (final ${r.final.toFixed(4)})\n${curve}${usageLine(payload.usage)}` },
        ],
        details: { ...r, usage: payload.usage },
      };
    },
  });
}
