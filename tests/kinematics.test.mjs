// Node test-runner checks for the kinematics, IK, reach map and collisions against
// tests/kinematics_fixtures.json. The fixtures are a regression snapshot made by
// tests/gen_fixtures.mjs (see the comment there for why they are no longer the
// Python v4 numbers); the forward-kinematics part is cross-checked by an
// independent Python implementation, tests/check_fk_fixtures.py.
// Run with:  node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as cfg from "../js/arm_config.js";
import * as kin from "../js/kinematics.js";
import * as col from "../js/collision.js";
import { radialProfileSync } from "../js/reach_map.js";

const fx = JSON.parse(fs.readFileSync(new URL("./kinematics_fixtures.json", import.meta.url), "utf8"));

test("fixtures were generated for the current arm dimensions", () => {
  for (const k of ["BASE_HEIGHT", "SHOULDER_OFFSET", "UPPER_ARM", "FOREARM", "ELBOW_OFFSET", "WRIST_TO_FLANGE"]) assert.equal(fx.config[k], cfg[k], `${k}: run node tests/gen_fixtures.mjs`);
  assert.deepEqual(fx.config.TOOL_LENGTH, cfg.TOOL_LENGTH);
});

test("the real-arm geometry: VEX's lesson poses", () => {
  // side-view diagram [arm_config S7]: upper arm vertical, forearm level, tool straight down -> TCP (195, 0, 192)
  const p = kin.forwardKinematics([0, 0, 0, 0, 90, 0], cfg.TOOL_LENGTH.MAGNET).points();
  assert.ok(Math.abs(p.tool[0] - 194.5) < 0.01 && Math.abs(p.tool[2] - 193.5) < 0.01, `tool ${p.tool}`);
  // the lesson's TCP on Tile location 36 = (200, 200, 0) with the tool pointing down [S6]
  const r = kin.solveIK([200, 200, 0], { toolDir: kin.DOWN });
  assert.ok(r.success, r.reason);
  // the safe position and the furthest point of the 8 class examples are reachable tool-down
  for (const t of [[120, 0, 100], [150, 150, 5], [170, 150, 0], [150, -40, 50]]) assert.ok(kin.solveIK(t, { toolDir: kin.DOWN }).success, `${t}`);
  // ... and the advertised 335 mm is just past what the measured links allow (330 mm)
  assert.ok(!kin.solveIK([336, 0, 60], { toolDir: kin.DOWN }).success);
  assert.ok(kin.solveIK([300, 0, 0], { toolDir: kin.DOWN }).success);
});
const close = (a, b, tol, msg) => {
  assert.equal(a.length, b.length, msg);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= tol, `${msg}[${i}]: ${a[i]} vs ${b[i]}`);
};

test("forward kinematics matches the fixture (30 random poses, 3 tools)", () => {
  for (const c of fx.fk) {
    const f = kin.forwardKinematics(c.q, c.toolLength);
    const pts = f.points();
    for (const [k, v] of Object.entries(c.points)) close(pts[k], v, 1e-4, `q=${c.q} ${k}`);
    f.rotation.forEach((row, i) => close(row, c.rotation[i], 1e-6, `rot row ${i}`));
  }
});

test("pose problems and self collisions match the fixture", () => {
  for (const c of fx.fk) {
    assert.deepEqual(kin.poseProblems(c.q, c.toolLength), c.problems, `q=${c.q}`);
    if (c.selfHits) {
      const hits = col.armSelfHits(kin.forwardKinematics(c.q, c.toolLength), c.tool).map((h) => [...h]).sort();
      assert.deepEqual(hits, c.selfHits, `self hits q=${c.q}`);
    }
  }
});

test("inverse kinematics matches the fixture (success, reason and joints)", () => {
  for (const c of fx.ik) {
    const r = kin.solveIK(c.target, { toolDir: c.mode === "down" ? kin.DOWN : null });
    const tag = `${c.mode} ${c.target}`;
    assert.equal(r.success, c.success, `${tag}: ${r.reason} / ${c.reason}`);
    assert.equal(r.reason, c.reason, tag);
    close(r.q, c.q, 0.01, `${tag} q`);
    if (r.success) close(kin.forwardKinematics(r.q).position, c.target, 0.05, `${tag} tcp`);
  }
});

test("straight-line plan matches the fixture", () => {
  const p = fx.plan;
  const keys = kin.planLinear(p.qStart, p.target, null, kin.DOWN);
  assert.ok(keys && p.keys);
  assert.equal(keys.length, p.keys.length);
  keys.forEach((k, i) => close(k, p.keys[i], 0.01, `key ${i}`));
});

test("reach-map radial profile matches the fixture", () => {
  for (const [z, ref] of Object.entries(fx.reach)) {
    const ok = radialProfileSync(Number(z), refToolLength()).ok;
    const diffs = ref.ok.reduce((n, v, i) => n + (v !== !!ok[i]), 0);
    assert.ok(diffs <= 1, `z=${z}: ${diffs} radii differ`);
  }
});
function refToolLength() { return fx.fk.find((c) => c.tool === "MAGNET").toolLength; }
