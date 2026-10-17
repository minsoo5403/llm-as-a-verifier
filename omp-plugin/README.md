# LLM-as-a-Verifier for OMP

An [OMP](https://github.com/oh-my-pi) plugin that exposes this repository's
`llm_verifier` package as agent tools and as two opt-in automatic routes. The
verifier stays in Python; the plugin only marshals one JSON request per call
through `python/omp_bridge.py`, so no scoring logic is duplicated in
TypeScript.

```
tools           verify_compare / verify_select / verify_progress   (always on)
gate            session_stop  -> score the finished turn, ask for a continuation
context         tool_result   -> score progress, pass the number back
proxy           llm-verifier/verified -> generate N, verify, replay the winner
      │
      ▼
omp-plugin/python/omp_bridge.py    (one process per call)
      │
      ▼
llm_verifier.select / compare / track
      │
      ▼
DeepSeek (deepseek-flash) — a logprob-capable backend
```

## Requirement: a logprob-capable verifier backend

The reward is an expectation over the verifier's score-token distribution, so
the backend **must return token logprobs**. The plugin uses whatever
`llm_verifier` resolves: `OPENAI_BASE_URL`, then `DEEPSEEK_API_KEY`, then
`VERTEX_API_KEY` (Vertex AI only). **Anthropic cannot verify** — its API returns
no token logprobs. A weaker model verifying a stronger one is the intended
setup, and is what the paper measures (Opus 5.5 rollouts verified by DeepSeek
V4.1 Flash).

Verified on this machine:

```
$ curl https://api.deepseek.com/chat/completions   # logprobs: true, top_logprobs: 20
model: deepseek-flash
RESULT: logprobs present; alternatives at the score position: 20
  token='O' logprob=0.0000 p=1.0000
```

Configure the key in the repository's `.env` (git-ignored):

```
DEEPSEEK_API_KEY=...
DEEPSEEK_EFFORT=high      # off | low | high | max
```

## Install

```bash
uv venv .venv && uv pip install -e .            # the verifier itself
omp plugin install /path/to/llm-as-a-verifier/omp-plugin
omp plugin list                                 # ● @minsoo5403/llm-verifier-omp
```

The link is enabled, so the extension loads in **every** OMP session from any
directory. Disable with
`omp plugin uninstall @minsoo5403/llm-verifier-omp`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_VERIFIER_ROOT` | the plugin's parent directory | repository root to import from, and to read `.env` from |
| `LLM_VERIFIER_PYTHON` | `<root>/.venv/Scripts/python.exe`, else `python`/`python3` | interpreter that runs the bridge |
| `LLM_VERIFIER_GATE` / `_CONTEXT` / `_PROXY` | off | force a route on for one process |
| `LLM_VERIFIER_MODEL` / `_EFFORT` | backend default / `high` | verifier model and reasoning effort |

## Tools (always on)

| Tool | What it does | Cost |
| --- | --- | --- |
| `verify_compare` | fine-grained rewards for one directed pair, in `[0, 1]` | 1 call per criterion × `n_evaluations` |
| `verify_select` | best of N via the Probabilistic Pivot Tournament | `O(Nk)` calls |
| `verify_progress` | per-step progress curve for a finished trajectory | `K` calls regardless of length |

Measured (DeepSeek `deepseek-flash`, `DEEPSEEK_EFFORT=high`):

```
verify_select(problem="Write a function that reverses a string.",
              candidates=["def rev(s): return s[::-1]",      # correct
                          "def rev(s): return s",
                          "def rev(s): return ''.join(sorted(s))"],
              criteria=["Correctness: does the code reverse the string?"])
-> selected candidate 0 after 6 comparisons
   [0] 0.7311  <- selected
   [1] 0.3845
   [2] 0.3845
```

Those numbers reproduce the scores published in the upstream README
(`0.73104 / 0.38446 / 0.38449`).

## Automatic routes (opt-in, default OFF)

Each route spends real verifier tokens on the full trajectory, so none of them
runs until you turn it on.

### `gate` — score the finished turn

On `session_stop` the plugin scores the turn with `track` (checkpoint = last
step: *would the agent's current state already complete the task?*). Below
`gate.min_score` it returns an advisory continuation instead of letting the
turn settle. Bounded by `gate.max_continuations`, skipped when
`stop_hook_active` is set, and it never blocks a completion outright.

```
/verifier gate on
/verifier score 0.6          # bar for gate and context
```

Measured on this machine (`bar=1` forces the trigger):

```
{"level":"info","message":"llm-verifier: gate fired score=0.999572094813734 bar=1 continuation=1/1"}
```

### `context` — score progress after a tool

After a `tool_result` from a configured tool with enough output, the plugin
scores the run so far and passes the number back as passive `additionalContext`
— but only while the verifier still judges the task incomplete
(`context.min_score`). Bounded by `context.max_calls_per_turn`.

```
/verifier context on
/verifier tools bash,eval
```

Measured:

```
{"level":"info","message":"llm-verifier: progress injected score=0.9999502341838077 tool=bash step=1"}
```

### `proxy` — verified-model provider

With `proxy` on, the extension registers `llm-verifier/verified`. Selecting that
model generates `proxy.candidates` responses with the **upstream** model
(`proxy.upstream`, or your session's own model when it is not the proxy itself),
ranks them with `select`, and replays the winner's events.

```
/verifier proxy on
/verifier upstream opencode-go/deepseek-v4.1-flash
omp --model llm-verifier/verified "…"
```

Measured on this machine:

```
{"level":"info","message":"llm-verifier: proxy generating 3 candidates with opencode-go (credential resolved)"}
{"level":"info","message":"llm-verifier: proxy selected candidate 1 of 3 (scored 3, 6 comparisons)"}
```

Two things the implementation has to get right, both found by running it:

- **The upstream is never the proxy.** A generation routed back into this
  provider forks into `candidates` more generations per level; the first
  version hung exactly that way. `proxy.upstream` names the upstream
  explicitly, and the session model is used only when it is not
  `llm-verifier/verified`.
- **The host's request options belong to the proxy.** Forwarding them verbatim
  handed the upstream the proxy's placeholder key and model id (`401 Invalid
  credential`). Provider-scoped fields (`apiKey`, `credentialId`,
  `oauthIdentity`, `providerSessionState`, `model`) are dropped, and the
  upstream's own credential is resolved — first through the host's
  `getApiKey`, then from OMP's credential store (`~/.omp/agent/agent.db`), then
  from the env var named by `proxy.api_key_env`.

Tradeoffs, stated plainly: generation cost is multiplied by the candidate
count, and **the reply arrives as one burst** — nothing streams until the
tournament has decided. Candidates with almost no text (tool-call-only turns,
one-word answers) are not scored; if fewer than two candidates carry at least 40
characters, the first response is returned unverified. Provider registration
happens at session start, so turning `proxy` on takes effect in the next
session.

## Configuration

`/verifier` writes the user file; a project file overrides it:

```
<agent dir>/llm-verifier.json        # default ~/.omp/agent/llm-verifier.json
<cwd>/.omp/llm-verifier.json
```

```json
{
  "verifier": { "model": null, "effort": "high" },
  "gate":     { "enabled": false, "min_score": 0.5, "max_continuations": 2, "n_evaluations": 1 },
  "context":  { "enabled": false, "tools": ["bash"], "min_output_chars": 400,
                "max_calls_per_turn": 2, "min_score": 0.5 },
  "proxy":    { "enabled": false, "upstream": null, "api_key_env": "DEEPSEEK_API_KEY",
                "candidates": 3, "pivots": 2, "n_evaluations": 1 }
}
```

Unknown keys are ignored, numbers are clamped, and junk values fall back to the
defaults rather than reaching the verifier.

| Command | Effect |
| --- | --- |
| `/verifier` | status: bridge, interpreter, backend, model, every route |
| `/verifier gate\|context\|proxy on\|off` | toggle one route |
| `/verifier model <id>\|default` | verifier model (must be a logprob backend) |
| `/verifier upstream <provider>/<model>` | model that generates proxy candidates |
| `/verifier effort off\|low\|high\|max` | DeepSeek reasoning effort |
| `/verifier score <0..1>` | completion bar for `gate` and `context` |
| `/verifier tools bash,eval` | which tools trigger `context` |
| `/verifier reset` | restore every default (routes off) |

## Cost

| Call | Measured |
| --- | --- |
| `compare`, one criterion, tiny prompt | 3–4 s, in 349 / out 253 tokens |
| `select`, 3 candidates, 6 comparisons | ~9 s |
| `track`, 4 steps, `effort=off` | 1.4 s, in 643 / out 7 tokens |

Cost scales with trajectory size, not with the plugin: a Terminal-Bench-sized
trajectory (~80k tokens) costs ~80k input tokens **per comparison**, and the
`gate` sends the whole turn. `effort=off` is much cheaper and was enough for
the smoke checks; the paper's accuracy numbers use `high`.

## Tests

```bash
bun test omp-plugin/tests                                   # pure modules, no runtime
.venv/Scripts/python.exe -m unittest discover -s omp-plugin/tests -v
LLM_VERIFIER_LIVE=1 .venv/Scripts/python.exe -m unittest discover -s omp-plugin/tests -v
```

The Python suite covers the bridge contract (ping, error paths, `--out`);
`LLM_VERIFIER_LIVE=1` adds the one test that spends a real verifier call.
