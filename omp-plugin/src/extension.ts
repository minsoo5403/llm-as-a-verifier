/**
 * OMP extension: LLM-as-a-Verifier.
 *
 * Three always-available tools (`verify_compare`, `verify_select`,
 * `verify_progress`) plus three opt-in automatic routes:
 *
 *   gate     `session_stop` — score the finished turn; below `gate.min_score`
 *            the hook asks for a continuation instead of letting it settle.
 *   context  `tool_result`  — score progress after a configured tool and pass
 *            the number back as passive context while the task is incomplete.
 *   proxy    `llm-verifier/verified` — generate N candidates with an upstream
 *            model, rank them, replay the winner.
 *
 * Every automatic route defaults to OFF (`/verifier gate on`), because each
 * one spends real verifier tokens on the full trajectory.
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { callBridge, findBridge, resolvePython, usageLine, type BridgeCallOptions } from "./bridge";
import { loadConfig, type VerifierConfig } from "./config";
import { problemOf, stepsOf, textOfBlocks, truncateStep } from "./transcript";
import { isProxyModel, registerProxyProvider } from "./proxy";
import { runVerifierCommand } from "./command";

function bridgeOptions(config: VerifierConfig): BridgeCallOptions {
  return { model: config.verifier.model, effort: config.verifier.effort };
}

function scoreOf(result: Record<string, unknown> | undefined): number {
  const raw = result?.final ?? result?.score;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : Number.NaN;
}

export default function llmVerifierExtension(pi: ExtensionAPI) {
  const z = pi.zod;
  const readConfig = () => loadConfig(pi.cwd).config;

  let gateContinuations = 0;
  let contextCalls = 0;
  let taskText = "";
  let stepLog: string[] = [];
  let liveModel: unknown = undefined;
  let resolveModelSpec: (spec: string) => unknown = () => undefined;

  pi.setLabel("LLM-as-a-Verifier");

  if (readConfig().proxy.enabled) {
    registerProxyProvider({
      pi,
      config: readConfig,
      liveModel: () => liveModel,
      resolveModelSpec: (spec) => resolveModelSpec(spec),
      log: (message) => pi.logger.info(message),
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    const { bridge } = findBridge();
    if (!existsSync(bridge)) {
      ctx.ui.notify(
        `llm-verifier: bridge missing at ${bridge} (set LLM_VERIFIER_ROOT)`,
        "warning",
      );
    }
  });

  // A fresh user prompt starts a new task: reset the per-task route budgets.
  pi.on("before_agent_start", async (event) => {
    gateContinuations = 0;
    contextCalls = 0;
    stepLog = [];
    if ("prompt" in event && typeof event.prompt === "string") taskText = event.prompt;
  });

  pi.on("turn_start", async (_event, ctx) => {
    contextCalls = 0;
    if ("models" in ctx) {
      resolveModelSpec = (spec) => ctx.models.resolve(spec);
      const current = ctx.models.current();
      if (current && !isProxyModel(current)) liveModel = current;
    }
  });

  pi.on("tool_result", async (event) => {
    const toolName = "toolName" in event && typeof event.toolName === "string" ? event.toolName : "";
    const output = "content" in event ? textOfBlocks(event.content) : "";
    const input = "input" in event ? JSON.stringify(event.input ?? {}) : "{}";
    stepLog.push(truncateStep(`tool ${toolName} ${truncateStep(input, 600)}\n-> ${output}`));

    const config = readConfig();
    if (!config.context.enabled) return;
    if (!config.context.tools.includes(toolName)) return;
    if (output.length < config.context.min_output_chars) return;
    if (contextCalls >= config.context.max_calls_per_turn) return;
    if (!taskText || stepLog.length === 0) return;

    contextCalls += 1;
    try {
      const payload = await callBridge(
        pi,
        "track",
        {
          problem: taskText,
          steps: stepLog,
          checkpoint_steps: [stepLog.length],
          n_evaluations: config.context.n_evaluations,
        },
        bridgeOptions(config),
      );
      const score = scoreOf(payload.result);
      if (!Number.isFinite(score) || score >= config.context.min_score) {
        pi.logger.info(`llm-verifier: progress ok score=${score}`);
        return;
      }
      pi.logger.info(
        `llm-verifier: progress injected score=${score} tool=${toolName} step=${stepLog.length}`,
      );
      return {
        additionalContext:
          `<verifier-progress score="${score.toFixed(3)}" bar="${config.context.min_score}">` +
          `A logprob verifier scored the current state ${score.toFixed(3)} of 1 against the task, ` +
          `below the completion bar. Trust observed output over narration: check what is still ` +
          `missing before continuing.</verifier-progress>`,
      };
    } catch (err) {
      pi.logger.warn(
        `llm-verifier: progress check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  pi.on("session_stop", async (event) => {
    const config = readConfig();
    if (!config.gate.enabled) return;
    if ("stop_hook_active" in event && event.stop_hook_active === true) return;
    if (gateContinuations >= config.gate.max_continuations) return;

    const messages = "messages" in event ? event.messages : undefined;
    const problem = problemOf(messages) || taskText;
    const steps = stepsOf(messages);
    if (!problem || steps.length === 0) return;

    let score: number;
    try {
      const payload = await callBridge(
        pi,
        "track",
        {
          problem,
          steps,
          checkpoint_steps: [steps.length],
          n_evaluations: config.gate.n_evaluations,
        },
        bridgeOptions(config),
      );
      score = scoreOf(payload.result);
    } catch (err) {
      pi.logger.warn(
        `llm-verifier: gate check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (!Number.isFinite(score) || score >= config.gate.min_score) {
      pi.logger.info(`llm-verifier: gate passed score=${score}`);
      return;
    }

    gateContinuations += 1;
    pi.logger.info(
      `llm-verifier: gate fired score=${score} bar=${config.gate.min_score} ` +
        `continuation=${gateContinuations}/${config.gate.max_continuations}`,
    );
    return {
      continue: true,
      additionalContext:
        `<verifier-gate score="${score.toFixed(3)}" bar="${config.gate.min_score}" ` +
        `attempt="${gateContinuations}/${config.gate.max_continuations}">` +
        `The turn ended, but a logprob verifier scored the state ${score.toFixed(3)} of 1 ` +
        `against the task — below the completion bar. Either finish the missing work, or ` +
        `state plainly what remains and why it cannot be done.</verifier-gate>`,
    };
  });

  pi.registerCommand("verifier", {
    description:
      "LLM-as-a-Verifier: status, gate|context|proxy on|off, model <id>|default, " +
      "upstream <provider>/<model>, effort <off|low|high|max>, score <0..1>, tools <a,b>, reset",
    handler: async (args, ctx) => {
      await runVerifierCommand(args, {
        cwd: pi.cwd,
        notify: (message, level) => ctx.ui.notify(message, level),
        bridgeStatus: async () => {
          const { bridge, repoRoot } = findBridge();
          const ping = await callBridge(pi, "ping", {});
          const info = ping.result ?? {};
          return [
            `bridge      ${existsSync(bridge) ? "ok" : "MISSING"} ${bridge}`,
            `python      ${resolvePython(repoRoot)}`,
            `backend     ${String(info.backend)}  (llm-verifier ${String(info.version)})`,
          ];
        },
      });
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
      const config = readConfig();
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
        { ...bridgeOptions(config), signal },
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
      const config = readConfig();
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
        { ...bridgeOptions(config), signal },
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
      "verifier's logprob expectation (0 = certainly incomplete, 1 = verified " +
      "complete). Use it to find the step where a run stopped making progress.",
    parameters: z.object({
      problem: z.string(),
      steps: z.array(z.string()),
      n_evaluations: z.number().optional(),
    }),
    async execute(_id, params, signal) {
      const config = readConfig();
      const payload = await callBridge(
        pi,
        "track",
        {
          problem: params.problem,
          steps: params.steps,
          n_evaluations: params.n_evaluations ?? 1,
        },
        { ...bridgeOptions(config), signal },
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
          {
            type: "text",
            text: `progress (final ${r.final.toFixed(4)})\n${curve}${usageLine(payload.usage)}`,
          },
        ],
        details: { ...r, usage: payload.usage },
      };
    },
  });
}
