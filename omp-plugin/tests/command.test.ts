/**
 * Operator surface tests: `/verifier` writes the config the routes read.
 * Runs against a throwaway agent dir, never the real one.
 *   bun test omp-plugin/tests
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerifierCommand } from "../src/command";
import { loadConfig } from "../src/config";

let agentDir = "";
let cwd = "";
const notices: Array<{ message: string; level: string }> = [];

async function run(args: string) {
  notices.length = 0;
  await runVerifierCommand(args, {
    cwd,
    notify: (message, level) => notices.push({ message, level }),
    bridgeStatus: async () => ["bridge      ok /tmp/bridge.py", "backend     deepseek:deepseek-flash"],
  });
}

function storedConfig(): Record<string, unknown> {
  const path = join(agentDir, "llm-verifier.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "llmver-agent-"));
  cwd = mkdtempSync(join(tmpdir(), "llmver-cwd-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("/verifier", () => {
  test("status reports bridge, backend and every route without writing config", async () => {
    await run("status");
    expect(notices).toHaveLength(1);
    const text = notices[0].message;
    expect(text).toContain("deepseek:deepseek-flash");
    expect(text).toContain("gate        off");
    expect(text).toContain("context     off");
    expect(text).toContain("proxy       off");
    expect(text).toContain(join(agentDir, "llm-verifier.json"));
    expect(existsSync(join(agentDir, "llm-verifier.json"))).toBe(false);
  });

  test("toggles each route on and off", async () => {
    for (const route of ["gate", "context", "proxy"]) {
      await run(`${route} on`);
      expect(loadConfig(cwd).config[route as "gate" | "context" | "proxy"].enabled).toBe(true);
      await run(`${route} off`);
      expect(loadConfig(cwd).config[route as "gate" | "context" | "proxy"].enabled).toBe(false);
    }
  });

  test("refuses a toggle without on/off and writes nothing", async () => {
    await run("gate maybe");
    expect(notices[0].level).toBe("warning");
    expect(existsSync(join(agentDir, "llm-verifier.json"))).toBe(false);
  });

  test("selects the verifier model and clears it with default", async () => {
    await run("model gemini-2.5-flash");
    expect(loadConfig(cwd).config.verifier.model).toBe("gemini-2.5-flash");
    await run("model default");
    expect(loadConfig(cwd).config.verifier.model).toBeNull();
  });

  test("selects the proxy upstream model", async () => {
    await run("upstream opencode-go/deepseek-v4.1-flash");
    expect(loadConfig(cwd).config.proxy.upstream).toBe("opencode-go/deepseek-v4.1-flash");
    await run("upstream nope");
    expect(notices[0].level).toBe("warning");
    expect(loadConfig(cwd).config.proxy.upstream).toBe("opencode-go/deepseek-v4.1-flash");
  });

  test("accepts only known effort levels", async () => {
    await run("effort max");
    expect(loadConfig(cwd).config.verifier.effort).toBe("max");
    await run("effort extreme");
    expect(notices[0].level).toBe("warning");
    expect(loadConfig(cwd).config.verifier.effort).toBe("max");
  });

  test("sets the completion bar for gate and context together", async () => {
    await run("score 0.7");
    const config = loadConfig(cwd).config;
    expect(config.gate.min_score).toBe(0.7);
    expect(config.context.min_score).toBe(0.7);
    await run("score 2");
    expect(notices[0].level).toBe("warning");
    expect(loadConfig(cwd).config.gate.min_score).toBe(0.7);
  });

  test("sets the context tool allowlist", async () => {
    await run("tools bash,eval");
    expect(loadConfig(cwd).config.context.tools).toEqual(["bash", "eval"]);
    await run("tools");
    expect(notices[0].level).toBe("warning");
  });

  test("reset restores every default, including routes that were on", async () => {
    await run("gate on");
    await run("proxy on");
    await run("model something-else");
    await run("reset");
    const config = loadConfig(cwd).config;
    expect(config.gate.enabled).toBe(false);
    expect(config.proxy.enabled).toBe(false);
    expect(config.verifier.model).toBeNull();
    expect(config.context.tools).toEqual(["bash"]);
  });

  test("keeps keys it does not own", async () => {
    await run("gate on");
    const before = storedConfig();
    expect(before.gate).toBeDefined();
    await run("score 0.25");
    expect(loadConfig(cwd).config.gate.enabled).toBe(true);
    expect(loadConfig(cwd).config.gate.min_score).toBe(0.25);
  });

  test("reports an unknown subcommand", async () => {
    await run("frobnicate");
    expect(notices[0].level).toBe("warning");
    expect(notices[0].message).toContain("unknown subcommand");
  });
});
