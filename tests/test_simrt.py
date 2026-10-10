"""CPython tests for python/simrt.py (the async rewrite that runs student programs).

The browser runs the same file inside Pyodide; here a fake bridge answers the arm
calls instantly, so no browser is needed:   python tests/test_simrt.py   (Python 3.11+)
"""
import asyncio
import json
import os
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(SITE, "python"))
import simrt  # noqa: E402

msgs = []
calls = []
pos = [120.0, 0.0, 100.0]


async def fake_call(name, args):
    kind, values = json.loads(args)[:2]
    calls.append(kind)
    await asyncio.sleep(0)
    if kind in ("move_to", "move_inc"):
        x, y, z = values[:3]
        if kind == "move_inc":
            x, y, z = pos[0] + x, pos[1] + y, pos[2] + z
        if -15 <= z < 0:
            z = 0
        pos[:] = [x, y, z]
        return "true"
    if kind == "get":
        return json.dumps({"x": round(pos[0], 2), "y": round(pos[1], 2), "z": round(pos[2], 2)}.get(values[0], 0))
    if kind == "can_reach":                      # a rough reach test like the real arm's (base at the origin)
        mode, v = values[:2]
        if mode in ("to", "inc"):
            x, y, z = (v if mode == "to" else [pos[0] + v[0], pos[1] + v[1], pos[2] + v[2]])
            return "true" if (x * x + y * y) ** 0.5 <= 330 and 0 <= z <= 350 and (x * x + y * y + (z - 84) ** 2) ** 0.5 <= 360 else "false"
        return "true"
    return "true" if kind.startswith("can_") or kind.startswith("is_") else "null"


simrt.BRIDGE.post = lambda t: msgs.append(json.loads(t))
simrt.BRIDGE.clock = time.monotonic
simrt.BRIDGE.call = fake_call


def run(src, name="test", stop_after=None):
    msgs.clear()
    calls.clear()
    pos[:] = [120.0, 0.0, 100.0]

    async def go():
        if stop_after is not None:
            async def stopper():
                await asyncio.sleep(stop_after)
                simrt.on_message(json.dumps({"type": "stop"}))
            asyncio.ensure_future(stopper())
        return await simrt.rt.run(src, name)
    return asyncio.run(go())


def screen():
    return "".join(str(a) for m in msgs if m["type"] == "screen" and m["op"] == "write" for a in m["args"])


def error():
    return next((m for m in msgs if m["type"] == "error"), None)


class SimRuntime(unittest.TestCase):
    def test_bundled_examples(self):
        """Every example in examples/ runs to the end on the fake bridge, finishes at the
        Safe Position and makes the number of arm moves recorded in expected_sample_results.json."""
        with open(os.path.join(HERE, "expected_sample_results.json"), encoding="utf-8") as fh:
            expected = json.load(fh)
        files = sorted(f for f in os.listdir(os.path.join(SITE, "examples")) if f.endswith(".ctepython"))
        self.assertEqual(files, sorted(expected), "expected_sample_results.json must list exactly the bundled examples")
        for f, exp in expected.items():
            with open(os.path.join(SITE, "examples", f), encoding="utf-8") as fh:
                src = json.load(fh)["textContent"]
            with self.subTest(f):
                self.assertEqual(run(src, f), "finished", error())
                for a, b in zip(pos, exp["position"]):
                    self.assertAlmostEqual(a, b, delta=0.01)
                self.assertEqual(calls.count("move_to") + calls.count("move_inc"), exp["moves"], "number of arm moves")
                self.assertFalse([m for m in msgs if m["type"] == "screen" and "can't be reached" in str(m.get("args"))], "unreachable move")

    def test_stop_infinite_loop(self):
        self.assertEqual(run("x = 0\nwhile True:\n    x += 1\n", stop_after=0.3), "stopped")

    def test_stop_with_bare_except(self):
        src = "from cte import *\nwhile True:\n    try:\n        wait(10, MSEC)\n    except:\n        pass\n"
        self.assertEqual(run(src, stop_after=0.3), "stopped")

    def test_error_line(self):
        self.assertEqual(run("x = 1\n\ny = x / 0\n"), "error")
        self.assertEqual(error()["line"], 3)
        self.assertIn("ZeroDivisionError", error()["message"])

    def test_syntax_error_line(self):
        self.assertEqual(run("x = 1\nif x\n    pass\n"), "error")
        self.assertEqual(error()["line"], 2)

    def test_python_features(self):
        src = """from cte import *
brain = Brain()
def sq(v):
    return v * v
class P:
    def __init__(self, n):
        self.v = [i * 2 for i in range(n)]
    def total(self):
        return sum(self.v)
brain.screen.print(P(4).total(), sum(sq(i) for i in range(4)), any(sq(i) > 5 for i in range(4)))
brain.screen.print(sorted([3, 1, 2], key=lambda v: -v), list(map(lambda k: k + 1, [1, 2])), {k: sq(k) for k in (1, 2)})
"""
        self.assertEqual(run(src), "finished", error())
        self.assertIn("12 14 True", screen())
        self.assertIn("[3, 2, 1] [2, 3] {1: 1, 2: 4}", screen())

    def test_threads_and_wait(self):
        src = """from cte import *
brain = Brain()
def worker(n):
    wait(50, MSEC)
    brain.screen.print("w%d " % n)
Thread(worker, (1,))
cte_thread(worker, (2,))
brain.screen.print("main ")
wait(150, MSEC)
"""
        self.assertEqual(run(src), "finished", error())
        self.assertTrue(screen().startswith("main "), screen())
        self.assertIn("w1", screen())
        self.assertIn("w2", screen())

    def test_callback_limit_has_a_hint(self):
        self.assertEqual(run("def k(v):\n    return -v\nprint(sorted([3, 1, 2], key=k))\n"), "error")
        self.assertIn("lambda or a loop", error()["message"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
