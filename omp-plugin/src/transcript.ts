/**
 * Turn the `session_stop` / `tool_result` payloads into the inputs the
 * verifier takes: the task text and one string per agent step.
 *
 * Shapes come from a runtime probe of omp 18.11.3:
 *   user        { role, content: [{ type: "text", text }] }
 *   assistant   { role, content: [{ type: "thinking" } | { type: "text", text }
 *                                | { type: "toolCall", id, name, arguments }] }
 *   toolResult  { role, toolCallId, toolName, content: [{ type: "text", text }],
 *                 isError }
 */

const MAX_STEP_CHARS = 4000;
const MAX_STEPS = 40;

function blocksOf(message: unknown): unknown[] {
  if (!message || typeof message !== "object" || !("content" in message)) return [];
  const content = message.content;
  return Array.isArray(content) ? content : [];
}

function roleOf(message: unknown): string {
  if (!message || typeof message !== "object" || !("role" in message)) return "";
  const role = message.role;
  return typeof role === "string" ? role : "";
}

/** Keep both ends of a long step: the start holds the intent, the tail the outcome. */
export function truncateStep(text: string, limit: number = MAX_STEP_CHARS): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  return `${text.slice(0, head)}\n…[${text.length - limit} chars elided]…\n${text.slice(-tail)}`;
}

/** Concatenated text blocks of a content array (message content or tool output). */
export function textOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (!("type" in block) || block.type !== "text") continue;
    if ("text" in block && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

function describeToolCall(block: unknown): string | null {
  if (!block || typeof block !== "object" || !("type" in block)) return null;
  if (block.type !== "toolCall") return null;
  const name = "name" in block && typeof block.name === "string" ? block.name : "tool";
  const args = "arguments" in block ? JSON.stringify(block.arguments ?? {}) : "";
  return `tool ${name} ${truncateStep(args, 600)}`;
}

/** The task text: the newest user message that carries text. */
export function problemOf(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (roleOf(message) !== "user") continue;
    const text = textOfBlocks(blocksOf(message));
    if (text) return text;
  }
  return "";
}

/**
 * One step per tool action plus its observed output, with any trailing
 * assistant text as the final step. That is the "action + observed output"
 * shape `llm_verifier.track` expects.
 */
export function stepsOf(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  const steps: string[] = [];
  let pending: string[] = [];
  for (const message of messages) {
    const role = roleOf(message);
    const blocks = blocksOf(message);
    if (role === "assistant") {
      const text = textOfBlocks(blocks);
      if (text) pending.push(text);
      for (const block of blocks) {
        const call = describeToolCall(block);
        if (call) pending.push(call);
      }
      continue;
    }
    if (role === "toolResult") {
      const output = textOfBlocks(blocks) || "(no output)";
      const action = pending.length > 0 ? pending.join("\n") : "tool result";
      pending = [];
      steps.push(truncateStep(`${action}\n-> ${output}`));
    }
  }
  if (pending.length > 0) steps.push(truncateStep(pending.join("\n")));
  return steps.slice(-MAX_STEPS);
}
