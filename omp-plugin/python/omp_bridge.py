#!/usr/bin/env python3
"""JSON bridge between the OMP extension and the ``llm_verifier`` package.

Usage
-----
    python omp_bridge.py <request.json> [--root <repo>] [--out <response.json>]

The request file is ``{"command": ..., "params": {...}}``; the response JSON is
written to stdout (and additionally to ``--out`` when given). One process per
call: the verifier call dominates the latency, so a persistent sidecar buys
nothing worth the lifecycle risk.

Commands
--------
    ping      backend/version/credential report, no verifier call
    compare   fine-grained rewards for one directed pair
    select    Probabilistic Pivot Tournament best-of-N
    track     per-step progress curve for a finished trajectory
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback


def _model_kwargs(params):
    """Pass the configured verifier model through only when it is set, so the
    library's own backend default survives."""
    model = params.get("model")
    return {"model": model} if model else {}


def _dispatch(req, lv):
    command = req.get("command")
    p = req.get("params") or {}

    if command == "ping":
        from llm_verifier import fine_grained_reward as fgr
        fgr.load_dotenv(req.get("root") or os.getcwd())
        backend = "none"
        if os.environ.get("OPENAI_BASE_URL"):
            backend = "openai-compatible:" + os.environ["OPENAI_BASE_URL"]
        elif os.environ.get("DEEPSEEK_API_KEY"):
            backend = "deepseek:" + fgr.DEEPSEEK_MODEL
        elif os.environ.get("VERTEX_API_KEY"):
            backend = "vertex-gemini"
        return {
            "version": lv.__version__,
            "python": sys.version.split()[0],
            "executable": sys.executable,
            "backend": backend,
            "granularity": fgr.GRANULARITY,
            "effort": os.environ.get("DEEPSEEK_EFFORT", fgr.DEEPSEEK_REASONING_EFFORT),
        }

    if command == "compare":
        r_a, r_b = lv.compare(
            p["problem"], p["candidate_a"], p["candidate_b"],
            criteria=p["criteria"],
            n_evaluations=int(p.get("n_evaluations", 1)),
            **_model_kwargs(p),
        )
        return {"reward_a": r_a, "reward_b": r_b,
                "prefers": "a" if r_a > r_b else ("b" if r_b > r_a else "tie")}

    if command == "select":
        res = lv.select(
            p["problem"], p["candidates"],
            criteria=p["criteria"],
            n_evaluations=int(p.get("n_evaluations", 1)),
            pivots=int(p.get("pivots", 2)),
            seed=int(p.get("seed", 0)),
            progress=False,
            **_model_kwargs(p),
        )
        return {"index": res.index, "best": res.best, "scores": res.scores,
                "n_comparisons": res.n_comparisons,
                "criteria": res.criteria}

    if command == "track":
        res = lv.track(
            p["problem"], p["steps"],
            checkpoint_steps=p.get("checkpoint_steps"),
            n_evaluations=int(p.get("n_evaluations", 1)),
            **_model_kwargs(p),
        )
        return {"checkpoint_steps": res.steps, "scores": res.scores,
                "final": res.final}

    raise ValueError("unknown command: %r" % (command,))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("request")
    ap.add_argument("--root", default=None,
                    help="repository root to import llm_verifier from and to "
                         "read .env from")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    root = args.root or os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__))))
    if root and root not in sys.path:
        sys.path.insert(0, root)

    try:
        with open(args.request, encoding="utf8") as fh:
            req = json.load(fh)
        req.setdefault("root", root)
        params = req.get("params") or {}
        if params.get("effort"):
            # deepseek_reasoning_params() reads this at call time.
            os.environ["DEEPSEEK_EFFORT"] = str(params["effort"])

        from llm_verifier import fine_grained_reward as fgr
        fgr.load_dotenv(root)
        import llm_verifier as lv

        payload = {"ok": True, "result": _dispatch(req, lv),
                   "usage": lv.token_usage()}
    except Exception as exc:  # noqa: BLE001 - the bridge reports, never crashes
        payload = {"ok": False,
                   "error": "%s: %s" % (type(exc).__name__, exc),
                   "traceback": traceback.format_exc(limit=8)}

    text = json.dumps(payload, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf8") as fh:
            fh.write(text)
    sys.stdout.write(text)
    sys.stdout.flush()
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
