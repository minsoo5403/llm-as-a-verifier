"""Contract tests for the OMP bridge. No network and no API key required.

    <repo>/.venv/Scripts/python.exe -m unittest discover -s omp-plugin/tests -v

Set ``LLM_VERIFIER_LIVE=1`` to also run the one test that spends a real
verifier call (needs the backend key configured in the repo's .env).
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(os.path.dirname(HERE), "python", "omp_bridge.py")
ROOT = os.path.dirname(os.path.dirname(HERE))


def run_bridge(request, *extra):
    """Run the bridge on a temp request file; return (proc, parsed stdout)."""
    with tempfile.TemporaryDirectory() as tmp:
        req_path = os.path.join(tmp, "request.json")
        with open(req_path, "w", encoding="utf8") as fh:
            json.dump(request, fh)
        proc = subprocess.run(
            [sys.executable, BRIDGE, req_path, "--root", ROOT, *extra],
            capture_output=True, text=True, timeout=600,
        )
    return proc, json.loads(proc.stdout)


class BridgeContract(unittest.TestCase):
    def test_ping_reports_backend_without_spending_a_call(self):
        proc, payload = run_bridge({"command": "ping", "params": {}})
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload["result"]["granularity"], 20)
        self.assertIn("version", payload["result"])
        self.assertIn("backend", payload["result"])
        self.assertEqual(payload["usage"]["calls"], 0)
        self.assertEqual(proc.returncode, 0)

    def test_unknown_command_fails_cleanly(self):
        proc, payload = run_bridge({"command": "nope", "params": {}})
        self.assertFalse(payload["ok"])
        self.assertIn("unknown command", payload["error"])
        self.assertEqual(proc.returncode, 1)

    def test_unreadable_request_file_is_reported_not_raised(self):
        missing = os.path.join(HERE, "does-not-exist.json")
        proc = subprocess.run(
            [sys.executable, BRIDGE, missing, "--root", ROOT],
            capture_output=True, text=True, timeout=600,
        )
        payload = json.loads(proc.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("FileNotFoundError", payload["error"])
        self.assertEqual(proc.returncode, 1)

    def test_response_is_written_to_out_file_too(self):
        with tempfile.TemporaryDirectory() as tmp:
            req_path = os.path.join(tmp, "request.json")
            out_path = os.path.join(tmp, "response.json")
            with open(req_path, "w", encoding="utf8") as fh:
                json.dump({"command": "ping", "params": {}}, fh)
            proc = subprocess.run(
                [sys.executable, BRIDGE, req_path, "--root", ROOT, "--out", out_path],
                capture_output=True, text=True, timeout=600,
            )
            with open(out_path, encoding="utf8") as fh:
                from_file = json.load(fh)
        self.assertEqual(json.loads(proc.stdout), from_file)
        self.assertTrue(from_file["ok"])

    @unittest.skipUnless(os.environ.get("LLM_VERIFIER_LIVE") == "1",
                         "set LLM_VERIFIER_LIVE=1 to spend a real verifier call")
    def test_compare_live_separates_a_correct_answer_from_a_wrong_one(self):
        proc, payload = run_bridge({
            "command": "compare",
            "params": {
                "problem": "Write a function that reverses a string.",
                "candidate_a": "def rev(s): return s[::-1]",
                "candidate_b": "def rev(s): return s",
                "criteria": ["Correctness: does the code reverse the string?"],
                "n_evaluations": 1,
            },
        })
        self.assertTrue(payload["ok"], payload)
        self.assertGreater(payload["result"]["reward_a"], payload["result"]["reward_b"])
        self.assertEqual(payload["usage"]["calls"], 1)


if __name__ == "__main__":
    unittest.main()
