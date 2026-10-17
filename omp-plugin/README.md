# LLM-as-a-Verifier for OMP

An [OMP](https://github.com/oh-my-pi) plugin that exposes this repository's
`llm_verifier` package as **always-available agent tools**. The verifier itself
stays in Python; the plugin only marshals one JSON request per tool call
through `python/omp_bridge.py`, so no scoring logic is duplicated in
TypeScript.

```
agent tool call
      │
      ▼
omp-plugin/src/extension.ts        (OMP extension: tools + /verifier command)
      │  pi.exec, request JSON on a temp file
      ▼
omp-plugin/python/omp_bridge.py    (one process per call)
      │
      ▼
llm_verifier.select / compare / track   (fine-grained logprob reward, PPT)
      │
      ▼
DeepSeek (deepseek-flash) — a logprob-capable backend
```

## Requirement: a logprob-capable verifier backend

The reward is an expectation over the verifier's score-token distribution, so
the backend **must return token logprobs**. The plugin uses whatever
`llm_verifier` resolves: `OPENAI_BASE_URL`, then `DEEPSEEK_API_KEY`, then
`VERTEX_API_KEY` (Vertex AI only). **Anthropic cannot verify** — its API returns
no token logprobs.

Verified on this machine with DeepSeek:

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

The plugin lives in this repository, so install it from the checkout:

```bash
omp plugin install /path/to/llm-as-a-verifier/omp-plugin
```

That links the package into `~/.omp/plugins` and enables it, so the extension —
and therefore the three tools — load in **every** OMP session, including ones
started from other directories. Check it with:

```bash
omp plugin list          # ● @minsoo5403/llm-verifier-omp@0.1.0
omp plugin uninstall @minsoo5403/llm-verifier-omp    # to disable
```

The plugin needs the repository's own Python environment (it imports
`llm_verifier`):

```bash
uv venv .venv && uv pip install -e .
```

### Environment overrides

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_VERIFIER_ROOT` | the plugin's parent directory | repository root to import from and to read `.env` from |
| `LLM_VERIFIER_PYTHON` | `<root>/.venv/Scripts/python.exe`, else `python`/`python3` | interpreter that runs the bridge |

## Tools

| Tool | What it does | Cost |
| --- | --- | --- |
| `verify_compare` | fine-grained rewards for one directed pair, in `[0, 1]` | 1 call per criterion × `n_evaluations` |
| `verify_select` | best of N via the Probabilistic Pivot Tournament | `O(Nk)` calls |
| `verify_progress` | per-step progress curve for a finished trajectory | `K` calls regardless of length |

`/verifier` reports the bridge status, interpreter and resolved backend without
spending a verifier call.

Example (measured, DeepSeek `deepseek-flash`, `DEEPSEEK_EFFORT=high`):

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

Those three numbers reproduce the scores published in the upstream README
(`0.73104 / 0.38446 / 0.38449`).

## Cost and latency

- Each tool call is a real verifier request: ~3–8 s on DeepSeek with
  `DEEPSEEK_EFFORT=high` (one call), ~9 s for the 6-comparison `select` above.
- `select` costs `O(Nk)` calls, not one per candidate — but the candidates
  themselves are supplied by the caller, so nothing here generates them.
- The tools are **passive**: they run only when the agent (or you) calls them.
  No turn is verified automatically.

## What is not built yet

- **Automatic verification of the agent's own answers.** The always-on shape
  would be a `session_stop` gate that scores the finished turn and can request a
  continuation. It is deliberately absent: it doubles token spend per turn, so it
  should be opt-in and measured first.
- **A verified-model provider.** `select` ranking candidate *generations* (the
  TurboAgent design: N parallel candidates, tournament, best one returned) needs
  a registered provider with `streamSimple`; it changes streaming to a single
  burst and multiplies generation cost by N.

## Tests

```bash
# contract tests: no network, no API key
.venv/Scripts/python.exe -m unittest discover -s omp-plugin/tests -v

# also spend one real verifier call
LLM_VERIFIER_LIVE=1 .venv/Scripts/python.exe -m unittest discover -s omp-plugin/tests -v
```
