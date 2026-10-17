/**
 * `/verifier` command body.
 *
 * Kept free of OMP imports so the operator surface — the thing that turns
 * routes on and picks models — is unit-testable without a terminal.
 */

import { DEFAULT_CONFIG, configPaths, loadConfig, patchUserConfig } from "./config";

export const EFFORTS = ["off", "low", "high", "max"];

export type VerifierCommandDeps = {
  cwd: string;
  notify: (message: string, level: "info" | "warning" | "error") => void;
  /** Lines describing the bridge, interpreter and resolved backend. */
  bridgeStatus: () => Promise<string[]>;
};

function routeLines(cwd: string): string[] {
  const { config } = loadConfig(cwd);
  return [
    `model       ${config.verifier.model ?? "backend default"}`,
    `effort      ${config.verifier.effort}`,
    `gate        ${config.gate.enabled ? "ON" : "off"}  bar ${config.gate.min_score}, ` +
      `max ${config.gate.max_continuations} continuations`,
    `context     ${config.context.enabled ? "ON" : "off"}  tools ${config.context.tools.join(",")}, ` +
      `bar ${config.context.min_score}, max ${config.context.max_calls_per_turn}/turn`,
    `proxy       ${config.proxy.enabled ? "ON" : "off"}  ` +
      `upstream ${config.proxy.upstream ?? "(session model)"}, candidates ${config.proxy.candidates}`,
    `config      ${configPaths(cwd).user}`,
  ];
}

export async function runVerifierCommand(
  args: string,
  deps: VerifierCommandDeps,
): Promise<void> {
  const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const value = rest[0] ?? "";
  const truthy = value === "on" || value === "1" || value === "true";
  const falsy = value === "off" || value === "0" || value === "false";

  try {
    if (sub === "status") {
      const lines = [...(await deps.bridgeStatus()), ...routeLines(deps.cwd)];
      deps.notify(lines.join("\n"), "info");
      return;
    }

    if (sub === "gate" || sub === "context" || sub === "proxy") {
      if (!truthy && !falsy) {
        deps.notify(`usage: /verifier ${sub} on|off`, "warning");
        return;
      }
      const path = patchUserConfig(deps.cwd, { [sub]: { enabled: truthy } });
      deps.notify(`llm-verifier: ${sub} ${truthy ? "on" : "off"} in ${path}`, "info");
      return;
    }

    if (sub === "model") {
      if (!value) {
        deps.notify("usage: /verifier model <verifier-model-id>|default", "warning");
        return;
      }
      const path = patchUserConfig(deps.cwd, {
        verifier: { model: value === "default" ? null : value },
      });
      deps.notify(`llm-verifier: verifier model -> ${value} (${path})`, "info");
      return;
    }

    if (sub === "upstream") {
      if (!value.includes("/")) {
        deps.notify("usage: /verifier upstream <provider>/<model>", "warning");
        return;
      }
      const path = patchUserConfig(deps.cwd, { proxy: { upstream: value } });
      deps.notify(`llm-verifier: proxy upstream -> ${value} (${path})`, "info");
      return;
    }

    if (sub === "effort") {
      if (!EFFORTS.includes(value)) {
        deps.notify(`usage: /verifier effort ${EFFORTS.join("|")}`, "warning");
        return;
      }
      const path = patchUserConfig(deps.cwd, { verifier: { effort: value } });
      deps.notify(`llm-verifier: effort -> ${value} (${path})`, "info");
      return;
    }

    if (sub === "score") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        deps.notify("usage: /verifier score <0..1>", "warning");
        return;
      }
      const path = patchUserConfig(deps.cwd, {
        gate: { min_score: parsed },
        context: { min_score: parsed },
      });
      deps.notify(`llm-verifier: completion bar -> ${parsed} (${path})`, "info");
      return;
    }

    if (sub === "tools") {
      const tools = rest.join(",").split(",").map((t) => t.trim()).filter(Boolean);
      if (tools.length === 0) {
        deps.notify("usage: /verifier tools bash,eval", "warning");
        return;
      }
      const path = patchUserConfig(deps.cwd, { context: { tools } });
      deps.notify(`llm-verifier: context tools -> ${tools.join(",")} (${path})`, "info");
      return;
    }

    if (sub === "reset") {
      const path = patchUserConfig(deps.cwd, {
        verifier: { ...DEFAULT_CONFIG.verifier },
        gate: { ...DEFAULT_CONFIG.gate },
        context: { ...DEFAULT_CONFIG.context },
        proxy: { ...DEFAULT_CONFIG.proxy },
      });
      deps.notify(`llm-verifier: every default restored (${path})`, "info");
      return;
    }

    deps.notify(`unknown subcommand: ${sub}`, "warning");
  } catch (err) {
    deps.notify(
      `llm-verifier: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  }
}
