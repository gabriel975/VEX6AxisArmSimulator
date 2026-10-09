// Node test-runner checks: the JavaScript kinematics must match the Python v4 simulator.
// Fixtures in python_fixtures.json were produced by the Python code (kinematics.py, reach_map.py,
// collision.py). Run with:  node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as kin from "../js/kinematics.js";
import * as col from "../js/collision.js";
import { radialProfileSync } from "../js/reach_map.js";

const fx = JSON.parse(fs.readFileSync(new URL("./python_fixtures.json", import.meta.url), "utf8"));
const close = (a, b, tol, msg) => {
  assert.equal(a.length, b.length, msg);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= tol, `${msg}[${i}]: ${a[i]} vs ${b[i]}`);
};

test("forward kinematics matches Python (30 random poses, 3 tools)", () => {
  for (const c of fx.fk) {
    const f = kin.forwardKinematics(c.q, c.toolLength);
    const pts = f.points();
    for (const [k, v] of Object.entries(c.points)) close(pts[k], v, 1e-4, `q=${c.q} ${k}`);
    f.rotation.forEach((row, i) => close(row, c.rotation[i], 1e-6, `rot row ${i}`));
  }
});

test("pose problems and self collisions match Python", () => {
  for (const c of fx.fk) {
    assert.deepEqual(kin.poseProblems(c.q, c.toolLength), c.problems, `q=${c.q}`);
    if (c.selfHits) {
      const hits = col.armSelfHits(kin.forwardKinematics(c.q, c.toolLength), c.tool).map((h) => [...h]).sort();
      assert.deepEqual(hits, c.selfHits, `self hits q=${c.q}`);
    }
  }
});

test("inverse kinematics matches Python (success, reason and joints)", () => {
  for (const c of fx.ik) {
    const r = kin.solveIK(c.target, { toolDir: c.mode === "down" ? kin.DOWN : null });
    const tag = `${c.mode} ${c.target}`;
    assert.equal(r.success, c.success, `${tag}: ${r.reason} / ${c.reason}`);
    assert.equal(r.reason, c.reason, tag);
    close(r.q, c.q, 0.01, `${tag} q`);
    if (r.success) close(kin.forwardKinematics(r.q).position, c.target, 0.05, `${tag} tcp`);
  }
});

test("straight-line plan matches Python", () => {
  const p = fx.plan;
  const keys = kin.planLinear(p.qStart, p.target, null, kin.DOWN);
  assert.ok(keys && p.keys);
  assert.equal(keys.length, p.keys.length);
  keys.forEach((k, i) => close(k, p.keys[i], 0.01, `key ${i}`));
});

test("reach-map radial profile matches Python", () => {
  for (const [z, ref] of Object.entries(fx.reach)) {
    const ok = radialProfileSync(Number(z), refToolLength()).ok;
    const diffs = ref.ok.reduce((n, v, i) => n + (v !== !!ok[i]), 0);
    assert.ok(diffs <= 1, `z=${z}: ${diffs} radii differ`);
  }
});
function refToolLength() { return fx.fk.find((c) => c.tool === "MAGNET").toolLength; }
