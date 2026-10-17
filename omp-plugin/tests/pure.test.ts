/**
 * Pure-module tests (no omp runtime, no network):
 *   bun test omp-plugin/tests
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config";
import { problemOf, stepsOf, textOfBlocks, truncateStep } from "../src/transcript";
import { upstreamApiKey, upstreamOptions } from "../src/upstream";

describe("normalizeConfig", () => {
  test("falls back to defaults for junk input", () => {
    for (const junk of [null, undefined, 42, "x", [], { gate: "nope" }]) {
      const config = normalizeConfig(junk);
      expect(config.gate.enabled).toBe(false);
      expect(config.gate.min_score).toBe(DEFAULT_CONFIG.gate.min_score);
      expect(config.context.tools).toEqual(DEFAULT_CONFIG.context.tools);
      expect(config.verifier.model).toBeNull();
    }
  });

  test("clamps numbers instead of trusting them", () => {
    const config = normalizeConfig({
      gate: { min_score: 5, max_continuations: -3, n_evaluations: 0 },
      proxy: { candidates: 99, pivots: 0 },
    });
    expect(config.gate.min_score).toBe(1);
    expect(config.gate.max_continuations).toBe(0);
    expect(config.gate.n_evaluations).toBe(1);
    expect(config.proxy.candidates).toBe(8);
    expect(config.proxy.pivots).toBe(1);
  });

  test("merges layer over base and ignores empty strings", () => {
    const base = normalizeConfig({ verifier: { model: "deepseek-flash", effort: "high" } });
    const merged = normalizeConfig({ verifier: { model: "   " }, gate: { enabled: true } }, base);
    expect(merged.verifier.model).toBe("deepseek-flash");
    expect(merged.gate.enabled).toBe(true);
    expect(merged.context.enabled).toBe(false);
  });

  test("keeps a tool allowlist only when non-empty", () => {
    expect(normalizeConfig({ context: { tools: [] } }).context.tools).toEqual(
      DEFAULT_CONFIG.context.tools,
    );
    expect(normalizeConfig({ context: { tools: ["bash", "", "eval"] } }).context.tools).toEqual([
      "bash",
      "eval",
    ]);
  });
});

const MESSAGES = [
  { role: "user", content: [{ type: "text", text: "first prompt" }] },
  { role: "assistant", content: [{ type: "text", text: "working" }] },
  { role: "user", content: [{ type: "text", text: "  the real task  " }] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hmm" },
      { type: "toolCall", id: "1", name: "bash", arguments: { command: "pytest -q" } },
    ],
  },
  { role: "toolResult", toolCallId: "1", toolName: "bash", content: [{ type: "text", text: "2 failed" }] },
  { role: "assistant", content: [{ type: "text", text: "done" }] },
];

describe("transcript", () => {
  test("problemOf returns the newest user text", () => {
    expect(problemOf(MESSAGES)).toBe("the real task");
    expect(problemOf([])).toBe("");
    expect(problemOf(undefined)).toBe("");
    expect(problemOf([{ role: "assistant", content: [{ type: "text", text: "x" }] }])).toBe("");
  });

  test("stepsOf pairs each tool call with its observed output", () => {
    const steps = stepsOf(MESSAGES);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain("tool bash");
    expect(steps[0]).toContain("pytest -q");
    expect(steps[0]).toContain("-> 2 failed");
    expect(steps[1]).toBe("done");
  });

  test("stepsOf keeps a trailing assistant action that has no result yet", () => {
    const steps = stepsOf([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "ls" } }],
      },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toContain("tool bash");
  });

  test("textOfBlocks joins only text blocks", () => {
    expect(textOfBlocks([{ type: "thinking", thinking: "x" }, { type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(textOfBlocks("not an array")).toBe("");
  });

  test("truncateStep keeps both ends and reports the elided middle", () => {
    const long = "S".repeat(300) + "TAIL";
    const cut = truncateStep(long, 100);
    expect(cut.length).toBeLessThan(long.length);
    expect(cut.startsWith("S")).toBe(true);
    expect(cut.endsWith("TAIL")).toBe(true);
    expect(cut).toContain("chars elided");
    expect(truncateStep("short", 100)).toBe("short");
  });
});

describe("upstream request options", () => {
  test("drops the provider-scoped fields that broke the upstream call", () => {
    const forwarded = upstreamOptions({
      apiKey: "unused-by-extension",
      credentialId: 20,
      oauthIdentity: { accountId: "x" },
      providerSessionState: { key: "v" },
      model: "verified",
      temperature: 0.7,
      signal: "sig",
    }) as Record<string, unknown>;
    expect(forwarded.apiKey).toBeUndefined();
    expect(forwarded.credentialId).toBeUndefined();
    expect(forwarded.oauthIdentity).toBeUndefined();
    expect(forwarded.providerSessionState).toBeUndefined();
    expect(forwarded.model).toBeUndefined();
    expect(forwarded.temperature).toBe(0.7);
    expect(forwarded.signal).toBe("sig");
  });

  test("passes non-objects through unchanged", () => {
    expect(upstreamOptions(undefined)).toBeUndefined();
    expect(upstreamOptions("nope")).toBe("nope");
  });

  test("asks the host getter for the upstream provider and ignores failures", async () => {
    const seen: string[] = [];
    const key = await upstreamApiKey(
      {
        getApiKey: (provider: string) => {
          seen.push(provider);
          return "sk-upstream";
        },
      },
      "opencode-go",
    );
    expect(key).toBe("sk-upstream");
    expect(seen).toEqual(["opencode-go"]);

    expect(await upstreamApiKey({}, "opencode-go")).toBeUndefined();
    expect(await upstreamApiKey({ getApiKey: "not a function" }, "opencode-go")).toBeUndefined();
    expect(
      await upstreamApiKey(
        {
          getApiKey: () => {
            throw new Error("no key");
          },
        },
        "opencode-go",
      ),
    ).toBeUndefined();
  });
});
