/**
 * Route D: a verified-model provider.
 *
 * `llm-verifier/verified` generates `proxy.candidates` responses with an
 * upstream model, ranks them with the fine-grained verifier, and replays the
 * winner's events. Nothing streams until the tournament has decided, so the
 * reply arrives as one burst — the same tradeoff TurboAgent makes.
 *
 * Candidate generation goes through the host's own `streamSimple`, so the
 * upstream's provider, credentials, tools and prompt handling are reused
 * exactly; this module never talks to an API itself.
 *
 * The upstream is never the proxy: a generation routed back into this provider
 * would fork into `candidates` more generations per level. `proxy.upstream`
 * names it explicitly, and the session's own model is used only when it is not
 * this provider.
 */

import {
  AssistantMessageEventStream,
  getBundledModel,
  getModel,
  streamSimple,
} from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { callBridge, type BridgeCallOptions } from "./bridge";
import type { VerifierConfig } from "./config";
import { upstreamCredential } from "./credentials";
import { upstreamApiKey, upstreamOptions } from "./upstream";
import { problemOf, textOfBlocks } from "./transcript";

export const PROXY_PROVIDER = "llm-verifier";
export const PROXY_MODEL_ID = "verified";

const CRITERIA = [
  "Correctness: does the response actually do what the task asks, without inventing files, APIs, or results?",
  "Completeness: does it finish the requested work and state plainly whatever it could not do?",
];

type Candidate = { events: unknown[]; message: unknown; text: string };

export function isProxyModel(model: unknown): boolean {
  return (
    Boolean(model) &&
    typeof model === "object" &&
    "provider" in model &&
    model.provider === PROXY_PROVIDER
  );
}

/** "provider/model" from config, or the session's own model when it is not the proxy. */
export function resolveUpstreamModel(
  spec: string | null,
  sessionModel: unknown,
  resolveSpec: (spec: string) => unknown,
): unknown {
  if (spec && !spec.startsWith(`${PROXY_PROVIDER}/`)) {
    try {
      const resolved = resolveSpec(spec);
      if (resolved && !isProxyModel(resolved)) return resolved;
    } catch {
      // fall through to the catalog and then to the session model
    }
    const slash = spec.indexOf("/");
    if (slash > 0) {
      const provider = spec.slice(0, slash);
      const id = spec.slice(slash + 1);
      if (provider !== PROXY_PROVIDER) {
        try {
          const bundled = getModel(provider, id) ?? getBundledModel(provider, id);
          if (bundled && !isProxyModel(bundled)) return bundled;
        } catch {
          // fall through
        }
      }
    }
  }
  return isProxyModel(sessionModel) ? undefined : sessionModel;
}

function keysOf(value: unknown): string {
  if (!value || typeof value !== "object") return typeof value;
  return Object.keys(value).join(",") || "(empty)";
}

/** Collect a real stream's events and final message without emitting anything. */
async function collectCandidate(source: AsyncIterable<unknown> & { result(): Promise<unknown> }) {
  const events: unknown[] = [];
  for await (const event of source) events.push(event);
  const message = await source.result();
  const blocks =
    message && typeof message === "object" && "content" in message ? message.content : undefined;
  return { events, message, text: textOfBlocks(blocks) };
}

export type ProxyDeps = {
  pi: ExtensionAPI;
  config: () => VerifierConfig;
  /** The session's live model, used only when it is not this provider. */
  liveModel: () => unknown;
  /** Session model resolver (ctx.models.resolve) for the configured spec. */
  resolveModelSpec: (spec: string) => unknown;
  log: (message: string) => void;
};

export function registerProxyProvider({
  pi,
  config,
  liveModel,
  resolveModelSpec,
  log,
}: ProxyDeps): void {
  pi.registerProvider(PROXY_PROVIDER, {
    // The extension owns the transport; this URL is never contacted.
    baseUrl: "https://llm-verifier.invalid/v1",
    apiKey: "unused-by-extension",
    api: "llm-verifier-proxy",
    models: [
      {
        id: PROXY_MODEL_ID,
        name: "Verified (best of N)",
        api: "llm-verifier-proxy",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 32_768,
      },
    ],
    streamSimple(model, context, options) {
      const out = new AssistantMessageEventStream();
      void runVerifiedTurn(out, model, context, options);
      return out;
    },
  });

  let loggedShapes = false;

  async function runVerifiedTurn(
    out: AssistantMessageEventStream,
    model: unknown,
    context: unknown,
    options: unknown,
  ): Promise<void> {
    const settings = config();
    if (!loggedShapes) {
      loggedShapes = true;
      log(
        `llm-verifier: proxy shapes model=[${keysOf(model)}] options=[${keysOf(options)}] ` +
          `context=[${keysOf(context)}]`,
      );
    }
    const upstream =
      resolveUpstreamModel(settings.proxy.upstream, liveModel(), resolveModelSpec) ?? model;
    if (isProxyModel(upstream)) {
      const message =
        "no upstream model: set proxy.upstream to a real provider/model " +
        "(for example opencode-go/deepseek-v4.1-flash)";
      log(`llm-verifier: proxy refused: ${message}`);
      out.fail(new Error(message));
      return;
    }

    try {
      const forwarded = upstreamOptions(options);
      const provider =
        upstream && typeof upstream === "object" && "provider" in upstream
          ? String(upstream.provider)
          : "";
      const key =
        (await upstreamApiKey(options, provider)) ??
        (provider ? upstreamCredential(provider, settings.proxy.api_key_env) : undefined);
      if (key) {
        (forwarded as Record<string, unknown>).apiKey = key;
      }
      log(
        `llm-verifier: proxy generating ${settings.proxy.candidates} candidates with ` +
          `${provider || "(unknown provider)"} (credential ${key ? "resolved" : "not resolved"})`,
      );
      const sources = await Promise.all(
        Array.from({ length: settings.proxy.candidates }, () =>
          streamSimple(upstream, context, forwarded) as unknown as AsyncIterable<unknown> & {
            result(): Promise<unknown>;
          },
        ),
      );
      const candidates: Candidate[] = [];
      for (const source of sources) candidates.push(await collectCandidate(source));

      const problem = problemOf(
        context && typeof context === "object" && "messages" in context
          ? context.messages
          : undefined,
      );
      const usable = candidates
        .map((candidate, index) => ({ index, text: candidate.text }))
        .filter((entry) => entry.text.length >= 40);

      let winner = 0;
      if (settings.proxy.enabled && problem && usable.length >= 2) {
        const bridgeOptions: BridgeCallOptions = {
          model: settings.verifier.model,
          effort: settings.verifier.effort,
        };
        const payload = await callBridge(
          pi,
          "select",
          {
            problem,
            candidates: usable.map((entry) => entry.text),
            criteria: CRITERIA,
            pivots: settings.proxy.pivots,
            n_evaluations: settings.proxy.n_evaluations,
            seed: 0,
          },
          bridgeOptions,
        );
        const picked = payload.result?.index;
        if (typeof picked === "number" && picked >= 0 && picked < usable.length) {
          winner = usable[picked].index;
        }
        log(
          `llm-verifier: proxy selected candidate ${winner} of ${settings.proxy.candidates} ` +
            `(scored ${usable.length}, ${String(payload.result?.n_comparisons)} comparisons)`,
        );
      } else {
        log(
          `llm-verifier: proxy returned candidate 0 without verification ` +
            `(problem=${problem ? "yes" : "none"}, scored candidates=${usable.length})`,
        );
      }

      for (const event of candidates[winner].events) out.push(event as never);
      out.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`llm-verifier: proxy failed: ${message}`);
      out.fail(new Error(`llm-verifier proxy: ${message}`));
    }
  }
}
