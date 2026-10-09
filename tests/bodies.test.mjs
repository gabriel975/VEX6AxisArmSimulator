// Objects on the Tile: mesh BVH queries, stacking / snap-to-surface, overlap checks,
// mesh-based arm collisions and the magnet carrying imported models.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MeshBVH } from "../js/mesh_bvh.js";
import * as B from "../js/bodies.js";
import * as col from "../js/collision.js";
import * as kin from "../js/kinematics.js";
import * as sio from "../js/scene_io.js";
import { parseModelBytes, parseSTL } from "../js/file_formats.js";
import { ModelItem } from "../js/model_library.js";
import { ArmController, SceneObject, MAGNET_RANGE_MESH } from "../js/arm_core.js";
import { binarySTL, cube, boxTriangles } from "./fixtures.mjs";

const read = (f) => fs.readFileSync(new URL("../models/" + f, import.meta.url));
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const pallet = (at = [150, 100, 0]) => { const m = new ModelItem("pallet.3mf", "3MF", parseModelBytes(read("test_pallet.3mf"), "p.3mf").positions, { library: "models/test_pallet.3mf" }); m.offset = [...at]; return m; };
const stlCube = (size, at = [0, 0, 0], name = "cube.stl") => { const m = new ModelItem(name, "STL", parseSTL(binarySTL(cube(size))), { data: 1 }); m.offset = [...at]; return m; };

test("MeshBVH: point distance and vertical hits on a 20 mm cube", () => {
  const bvh = new MeshBVH(parseSTL(binarySTL(cube(20))));          // local cube spans 0..20 on every axis
  assert.ok(near(bvh.pointDistance([10, 10, 25]), 5), "above the top face");
  assert.ok(near(bvh.pointDistance([-3, 10, 10]), 3), "beside a face");
  assert.ok(near(bvh.pointDistance([-3, -4, 10]), 5), "off an edge");
  assert.ok(near(bvh.pointDistance([10, 10, 10]), 10), "inside: distance to the nearest face");
  assert.equal(bvh.pointDistance([100, 0, 0], 50), 50, "cut-off returns maxDist");
  assert.deepEqual(bvh.verticalHits(10, 10).map((z) => +z.toFixed(6)), [0, 20]);
  assert.deepEqual(bvh.verticalHits(30, 10), []);
  assert.deepEqual(bvh.intervals(5, 15).map((iv) => iv.map((z) => +z.toFixed(6))), [[0, 20]]);
});

test("MeshBVH on a bigger mesh agrees with brute force", () => {
  const tris = [];
  for (let i = 0; i < 12; i++) for (let j = 0; j < 9; j++) tris.push(...boxTriangles([i * 7, j * 7, (i + j) % 3 * 4], [i * 7 + 5, j * 7 + 5, (i + j) % 3 * 4 + 6]));
  const p = Float32Array.from(tris.flat(2));
  const bvh = new MeshBVH(p);
  const brute = (q) => { let b = Infinity; for (let t = 0; t < p.length / 9; t++) b = Math.min(b, bvh.triDistance(t, q)); return b; };
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 200; k++) {
    const q = [rnd() * 100 - 10, rnd() * 80 - 10, rnd() * 30 - 5];
    assert.ok(near(bvh.pointDistance(q), brute(q), 1e-6), `point ${q}`);
  }
});

test("pallet: solid spans in the slot vs on a rail, resting heights, overlap", () => {
  const pal = pallet();
  assert.deepEqual(B.intervals(pal, 150, 100), [[0, 6]], "slot floor is 6 mm thick");
  assert.deepEqual(B.intervals(pal, 150, 78), [[0, 14]], "rail is 14 mm high");
  assert.deepEqual(B.intervals(pal, 300, 300), []);
  const c = new SceneObject("c", "cube", [150, 100, 60]);
  assert.equal(B.dropZ(c, [pal], { fromAbove: true }), 6, "a cube dropped into the slot rests on its floor");
  assert.equal(B.dropZ(c, [pal]), 6, "gravity from above gives the same");
  c.pos = [150, 78, 60];
  assert.equal(B.dropZ(c, [pal], { fromAbove: true }), 14, "over a rail it rests on the rail");
  c.pos = [150, 100, 6];
  assert.equal(B.overlaps(c, pal), false, "sitting in the slot is not an overlap");
  c.pos[2] = 3;
  assert.equal(B.overlaps(c, pal), true, "pushed into the floor is");
  c.pos = [150, 85, 6];
  assert.equal(B.overlaps(c, pal), true, "sideways into the rail is");
  assert.ok(near(B.pointDistance(pal, [150, 100, 8]), 2), "tip 2 mm above the slot floor");
  assert.equal(B.topUnder(pal, [150, 78, 15]), 14);
  assert.equal(B.topUnder(pal, [150, 100, 7]), 6);
});

test("yaw: bounds, spans and half size follow the rotation", () => {
  const pal = pallet([150, 100, 0]);
  pal.yaw = 90;
  const [lo, hi] = B.aabb(pal);
  assert.deepEqual([lo, hi].map((v) => v.map(Math.round)), [[120, 55, 0], [180, 145, 14]], "90 x 60 becomes 60 x 90");
  assert.deepEqual(B.halfSize(pal).map(Math.round), [30, 45]);
  assert.deepEqual(B.intervals(pal, 172, 100), [[0, 14]], "the rail is now along X");
  assert.deepEqual(B.intervals(pal, 150, 100), [[0, 6]]);
  const l = B.worldToLocal(pal, B.localToWorld(pal, [12, -7, 3]));
  assert.ok(near(l[0], 12, 1e-9) && near(l[1], -7, 1e-9) && near(l[2], 3, 1e-9));
});

test("cubes stack, never sink into the Tile, and models rest on cubes", () => {
  const a = new SceneObject("a", "cube", [50, 50, 0]), b = new SceneObject("b", "cube", [58, 55, 80]);
  assert.equal(B.dropZ(b, [a]), 25, "falls onto the lower cube");
  b.pos = [120, 50, 80];
  assert.equal(B.dropZ(b, [a]), 0, "misses it: falls to the Tile");
  b.pos = [58, 55, 10];
  assert.equal(B.dropZ(b, [a]), 10, "gravity never lifts a cube that is already inside something");
  assert.equal(B.dropZ(b, [a], { fromAbove: true }), 25, "snap-to-surface does lift it onto the top");
  const m = stlCube(30, [50, 50, 90]);
  assert.equal(B.dropZ(m, [a]), 25, "an imported model rests on a cube too");
  m.offset[2] = 25;
  const disk = new SceneObject("d", "disk", [50, 50, 100], { size: 30, height: 8 });
  assert.equal(B.dropZ(disk, [a, m]), 25 + 30, "and a disk on top of the model");
});

test("arm collision uses the real mesh: tool in the pallet slot is fine, into the rail is a hit", () => {
  const pal = pallet();
  const items = [{ name: pal.name, lo: B.aabb(pal)[0], hi: B.aabb(pal)[1], body: pal }];
  const fkAt = (p) => { const r = kin.solveIK(p, { toolDir: kin.DOWN }); assert.ok(r.success, `${p}: ${r.reason}`); return kin.forwardKinematics(r.q); };
  assert.deepEqual(col.armObjectHits(fkAt([150, 100, 9]), "MAGNET", items), [], "in the slot, 3 mm above its floor: no false positive");
  assert.deepEqual(col.armObjectHits(fkAt([150, 78, 9]), "MAGNET", items), [["tool", "pallet.3mf"]], "pushed into the rail");
  assert.deepEqual(col.armObjectHits(fkAt([150, 78, 18]), "MAGNET", items), [], "4 mm above the rail: clear");
  // the plain box test would have flagged the slot position
  assert.ok(col.capsuleBoxDistance(fkAt([150, 100, 9]).points().flange, fkAt([150, 100, 9]).points().tool, items[0].lo, items[0].hi) < 1);
});

test("magnet: picks up a magnetic model from its surface, carries it rigidly (with yaw), releases onto what is below", () => {
  const c = new ArmController();
  c.objects = [new SceneObject("Red cube", "cube", [100, 150, 0])];
  const pal = pallet([150, 100, 0]);
  const models = [pal];
  c.getModels = () => models;
  const at = (p) => { const r = kin.solveIK(p, { toolDir: kin.DOWN, qInit: c.q }); assert.ok(r.success, r.reason); c.setJoints(r.q); };
  at([150, 78, 14 + MAGNET_RANGE_MESH + 2]);
  c.setMagnet(true);
  assert.equal(c.held, null, "too far above the rail: nothing picked");
  c.setMagnet(false);
  at([150, 78, 15]);
  c.setMagnet(true);
  assert.equal(c.held?.body, pal, "1 mm above the rail top: picked up");
  assert.equal(pal.held, true);
  const yaw0 = c.toolYaw(), off0 = [...pal.offset];
  c.setJoints([c.q[0] + 30, ...c.q.slice(1)]);           // turn the whole arm 30 degrees
  assert.ok(near(pal.yaw, 30, 1e-6) || near(pal.yaw - (c.toolYaw() - yaw0), 0, 1e-6), `yaw ${pal.yaw}`);
  assert.ok(Math.hypot(pal.offset[0] - off0[0], pal.offset[1] - off0[1]) > 20, "it swung with the arm");
  at([100, 150, 60]);                                   // over the red cube, high up
  const tip = c.position();
  assert.ok(near(pal.offset[2], tip[2] - 15, 0.05), `keeps its vertical offset to the tip (${pal.offset[2]} vs ${tip[2] - 15})`);
  const wrap = (a) => ((a + 180) % 360 + 360) % 360 - 180;
  assert.ok(near(wrap(pal.yaw - (c.toolYaw() + c.held.relYaw)), 0, 1e-6), "rigid: yaw = tool yaw + the offset it was grabbed with");
  const yawCarried = pal.yaw;
  c.setMagnet(false);
  assert.equal(pal.held, false);
  assert.equal(c.held, null);
  assert.ok(near(pal.offset[2], 25, 1e-6), `released: rests on the 25 mm cube, got ${pal.offset[2]}`);
  assert.equal(pal.yaw, yawCarried, "released with the yaw it was carried at");
  assert.match(c.events.at(-1), /Dropped pallet/);
  // non-magnetic models are ignored
  pal.magnetic = false;
  at([pal.offset[0], pal.offset[1] - 22, 25 + 15]);
  c.setMagnet(true);
  assert.equal(c.held, null, "magnetic off: not picked");
  c.setMagnet(false);
  // cubes still work as before
  at([100, 150, 25 + 5]);
  pal.offset = [300, 300, 0];
  c.setMagnet(true);
  assert.equal(c.held?.body?.name, "Red cube");
  c.setMagnet(false);
});

test("scene files and undo snapshots carry yaw and magnetic", async () => {
  const m = stlCube(25, [120, 80, 0], "part.stl");
  m.yaw = 45; m.magnetic = false; m.userScale = 1;
  const c = new ArmController(); c.objects = [];
  const app = { c, models: [m], sceneToggles: () => ({ snap_to_surface: false, block_overlaps: true }), library: { bytes: async () => null }, toBase64: () => "" };
  const d = await sio.sceneToObject(app);
  assert.equal(d.models[0].yaw, 45);
  assert.equal(d.models[0].magnetic, false);
  assert.equal(d.toggles.snap_to_surface, false);
  assert.ok(sio.parseScene(sio.sceneText(d)).models[0].magnetic === false);
  const h = new sio.SceneHistory();
  h.push(app, "Turn part.stl");
  m.yaw = 60; m.magnetic = true; m.offset[2] = 30;
  assert.equal(h.undo(app), "Turn part.stl");
  assert.equal(m.yaw, 45); assert.equal(m.magnetic, false); assert.equal(m.offset[2], 0);
  assert.equal(h.redo(app), "Turn part.stl");
  assert.equal(m.yaw, 60); assert.equal(m.magnetic, true); assert.equal(m.offset[2], 30);
  // coalescing: repeated nudges within the window are one undo step
  const h2 = new sio.SceneHistory();
  for (let i = 0; i < 5; i++) { h2.push(app, "Move part.stl X", 1200); m.offset[0] += 10; }
  assert.equal(h2.undoStack.length, 1);
  h2.undo(app);
  assert.equal(m.offset[0], 120);
});
