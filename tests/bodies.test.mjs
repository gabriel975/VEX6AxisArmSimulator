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
  pal.rot = [0, 0, 90];
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
  assert.ok(near(B.dropZ(disk, [a, m]), 25 + 30, 1e-6), "and a disk on top of the model");
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
  const off0 = [...pal.offset];
  c.setJoints([c.q[0] + 30, ...c.q.slice(1)]);           // turn the whole arm 30 degrees
  assert.ok(near(pal.rot[2], 30, 1e-6), `turned with the arm: yaw ${pal.rot[2]}`);
  assert.ok(Math.hypot(pal.offset[0] - off0[0], pal.offset[1] - off0[1]) > 20, "it swung with the arm");
  at([100, 150, 60]);                                   // over the red cube, high up
  const tip = c.position();
  assert.ok(near(pal.offset[2], tip[2] - 15, 0.05), `keeps its vertical offset to the tip (${pal.offset[2]} vs ${tip[2] - 15})`);
  const Rexp = B.mul3(c.fk().rotation, c.held.relR);
  const Rgot = B.rotationMatrix(pal);
  assert.ok(Rexp.every((row, i) => row.every((v, j) => near(v, Rgot[i][j], 1e-6))), "rigid: R_body = R_tool * R_rel");
  const rotCarried = [...pal.rot];
  c.setMagnet(false);
  assert.equal(pal.held, false);
  assert.equal(c.held, null);
  assert.ok(near(pal.offset[2], 25, 0.05), `released: rests on the 25 mm cube, got ${pal.offset[2]}`);   // IK leaves it ~0.3 deg tilted
  assert.deepEqual(pal.rot, rotCarried, "released with the orientation it was carried at");
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

test("rotation maths: Euler <-> matrix round trip, axis rotations compose", () => {
  for (const r of [[0, 0, 0], [90, 0, 0], [0, -90, 45], [30, 40, -120], [-170, 10, 179]]) {
    const back = B.eulerFromMatrix(B.matrixFromEuler(r));
    const Rb = B.matrixFromEuler(back), Ra = B.matrixFromEuler(r);
    assert.ok(Ra.every((row, i) => row.every((v, j) => near(v, Rb[i][j], 1e-9))), `round trip ${r} -> ${back}`);
  }
  const p = B.apply3(B.axisRotation("z", 90), [1, 0, 0]);
  assert.ok(near(p[0], 0, 1e-12) && near(p[1], 1, 1e-12), "Rz(90) x -> y (right-handed)");
  const q = B.apply3(B.axisRotation("x", 90), [0, 1, 0]);
  assert.ok(near(q[1], 0, 1e-12) && near(q[2], 1, 1e-12), "Rx(90) y -> z");
});

test("rotation of every body type: disk on its edge, tilted cube, STL and 3MF - bounds, resting, nothing below the Tile", () => {
  const disk = new SceneObject("d", "disk", [100, 100, 0], { size: 30, height: 8 });
  B.setRotation(disk, [90, 0, 0]);                                   // stand it on its rim
  let [lo, hi] = B.aabb(disk);
  assert.ok(near(hi[0] - lo[0], 30, 1e-6) && near(hi[1] - lo[1], 8, 1e-6) && near(hi[2] - lo[2], 30, 1e-6), `disk on edge ${lo} ${hi}`);
  assert.ok(near(lo[2], 0, 1e-9), "lifted so it does not sink below the Tile: bottom " + lo[2]);
  assert.ok(near((lo[0] + hi[0]) / 2, 100, 1e-6) && near((lo[1] + hi[1]) / 2, 100, 1e-6), "turned about its centre");
  const spans = B.intervals(disk, 100, 100);
  assert.ok(spans.length === 1 && near(spans[0][0], 0, 1e-6) && near(spans[0][1], 30, 1e-6), `solid 0..30 through the middle: ${JSON.stringify(spans)}`);
  assert.deepEqual(B.intervals(disk, 100, 110), [], "nothing 10 mm beside the thin rim");
  // a cube tilted 45 degrees about X stands on an edge; it rests on another cube by that edge
  const base = new SceneObject("base", "cube", [100, 100, 0]);
  const c = new SceneObject("c", "cube", [100, 100, 80]);
  B.setRotation(c, [45, 0, 0]);
  [lo, hi] = B.aabb(c);
  assert.ok(near(hi[1] - lo[1], 25 * Math.SQRT2, 1e-6) && near(hi[2] - lo[2], 25 * Math.SQRT2, 1e-6), "tilted cube bounds " + (hi[1] - lo[1]));
  const z = B.dropZ(c, [base]);
  c.pos[2] = z; B.invalidateSamples(c);
  assert.ok(near(B.bottomZ(c), 25, 1e-6), `rests edge-down on the 25 mm cube: bottom ${B.bottomZ(c)}`);
  assert.equal(B.overlaps(c, base), false);
  B.rotateAbout(c, "z", 90);                                         // turning about Z keeps the edge on the cube
  assert.ok(near(B.bottomZ(c), 25, 1e-6) && near(B.rot(c)[2], 90, 1e-6), `${B.rot(c)} bottom ${B.bottomZ(c)}`);
  // the STL cube rolled 90 deg about Y is still a 30 mm cube on the floor; tilted it is lifted
  const m = stlCube(30, [50, 50, 0]);
  B.setRotation(m, [0, 90, 0]);
  [lo, hi] = B.aabb(m);
  assert.ok(near(lo[2], 0, 1e-6) && near(hi[2], 30, 1e-5), `rolled STL cube ${lo} ${hi}`);
  B.setRotation(m, [30, 20, 10]);
  assert.ok(near(B.bottomZ(m), 0, 1e-6), "tilted: lowest corner on the Tile");
  assert.ok(B.topZ(m) > 30, "and taller than flat");
  // the pallet (3MF) rolled onto its side: 60 mm tall, rails now vertical faces
  const pal = pallet([150, 100, 0]);
  B.setRotation(pal, [90, 0, 0]);
  [lo, hi] = B.aabb(pal);
  assert.ok(near(hi[0] - lo[0], 90, 1e-4) && near(hi[1] - lo[1], 14, 1e-4) && near(hi[2] - lo[2], 60, 1e-4), `pallet on its side ${lo} ${hi}`);
  assert.ok(near(lo[2], 0, 1e-9));
  const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
  // the plate (6 mm) now stands vertical on the +Y side; the line through the middle of the
  // 14 mm thickness only crosses the two rails (8 mm wide, 22 mm either side of the centre)
  const mid = B.intervals(pal, cx, cy);
  assert.ok(mid.length === 2 && near(mid[0][0], 4, 1e-4) && near(mid[0][1], 12, 1e-4) && near(mid[1][0], 48, 1e-4) && near(mid[1][1], 56, 1e-4), JSON.stringify(mid));
  const plate = B.intervals(pal, cx, hi[1] - 3);
  assert.ok(plate.length === 1 && near(plate[0][0], 0, 1e-4) && near(plate[0][1], 60, 1e-4), "through the plate: " + JSON.stringify(plate));
  // a cube dropped onto the side-lying pallet rests on its top edge (60), not on the old box top (14)
  const top = new SceneObject("t", "cube", [cx, cy, 100]);
  assert.ok(near(B.dropZ(top, [pal]), 60, 1e-4), "rests on the 60 mm high side-lying pallet");
  // collision uses the rotated geometry: a tool capsule where the flat pallet used to be is clear now
  const items = [{ name: pal.name, lo, hi, body: pal }];
  const fkAt = (p) => { const r = kin.solveIK(p, { toolDir: kin.DOWN }); assert.ok(r.success, r.reason); return kin.forwardKinematics(r.q); };
  assert.deepEqual(col.armObjectHits(fkAt([cx + 30, cy + 25, 9]), "MAGNET", items), [], "beside the upright pallet (where the flat one was)");
  assert.deepEqual(col.armObjectHits(fkAt([cx, cy, 50]), "MAGNET", items), [["tool", "pallet.3mf"]], "into the top of a rail (56 mm up on the side-lying pallet)");
});

test("magnet with rotation: grabs a turned cube by its real top, keeps the orientation rigidly while the tool tilts", () => {
  const c = new ArmController();
  const cube = new SceneObject("Red cube", "cube", [150, 100, 0]);
  B.setRotation(cube, [0, 0, 30]);
  c.objects = [cube];
  // pin the whole tool orientation (a plain "tool down" leaves its spin free, which a rigid grip would faithfully pass on)
  const down = kin.yprToMatrix(0, 0, 0);
  const at = (p, rot = down) => { const r = kin.solveIK(p, rot ? { targetRot: rot, qInit: c.q } : { toolDir: kin.DOWN, qInit: c.q }); assert.ok(r.success, r.reason); c.setJoints(r.q); };
  at([150, 100, 27]);
  c.setMagnet(true);
  assert.equal(c.held?.body, cube, "picked up the turned cube");
  const relR0 = c.held.relR.map((row) => [...row]);
  // tilt the tool 20 degrees (pitch) and move: the cube's rotation must follow R_tool * R_rel exactly
  at([150, 100, 90], kin.yprToMatrix(0, 0, 20));
  const Rexp = B.mul3(c.fk().rotation, relR0), Rgot = B.rotationMatrix(cube);
  assert.ok(Rexp.every((row, i) => row.every((v, j) => near(v, Rgot[i][j], 1e-6))), "carried orientation follows the tool");
  assert.ok(Math.abs(B.rot(cube)[0]) + Math.abs(B.rot(cube)[1]) > 10, `the cube is now tilted: ${B.rot(cube)}`);
  // back to straight down: the original orientation comes back (within IK tolerance)
  at([150, 100, 90]);
  const r = B.rot(cube);
  assert.ok(Math.abs(r[0]) < 1 && Math.abs(r[1]) < 1 && Math.abs(r[2] - 30) < 1, `orientation restored: ${r}`);
  c.setMagnet(false);
  assert.ok(near(B.bottomZ(cube), 0, 1e-3), "released flat onto the Tile: bottom " + B.bottomZ(cube));
  // a model tilted 45 degrees is picked up from its tilted top surface
  const m = stlCube(30, [60, 150, 0]);
  B.setRotation(m, [45, 0, 0]);
  c.getModels = () => [m];
  const topHit = B.topAt(m, 60, 150);
  at([60, 150, topHit + 3], null);
  c.setMagnet(true);
  assert.equal(c.held?.body, m, "picked the tilted model up by its ridge");
  c.setMagnet(false);
});

test("scene files and undo snapshots carry yaw and magnetic", async () => {
  const m = stlCube(25, [120, 80, 0], "part.stl");
  m.rot = [0, 0, 45]; m.magnetic = false; m.userScale = 1;
  const c = new ArmController(); c.objects = [];
  const app = { c, models: [m], sceneToggles: () => ({ snap_to_surface: false, block_overlaps: true }), library: { bytes: async () => null }, toBase64: () => "" };
  const d = await sio.sceneToObject(app);
  assert.deepEqual(d.models[0].rot, [0, 0, 45]);
  assert.equal(d.models[0].magnetic, false);
  assert.equal(d.toggles.snap_to_surface, false);
  assert.ok(sio.parseScene(sio.sceneText(d)).models[0].magnetic === false);
  const h = new sio.SceneHistory();
  h.push(app, "Turn part.stl");
  m.rot = [90, 0, 60]; m.magnetic = true; m.offset[2] = 30;
  assert.equal(h.undo(app), "Turn part.stl");
  assert.deepEqual(m.rot, [0, 0, 45]); assert.equal(m.magnetic, false); assert.equal(m.offset[2], 0);
  assert.equal(h.redo(app), "Turn part.stl");
  assert.deepEqual(m.rot, [90, 0, 60]); assert.equal(m.magnetic, true); assert.equal(m.offset[2], 30);
  // coalescing: repeated nudges within the window are one undo step
  const h2 = new sio.SceneHistory();
  for (let i = 0; i < 5; i++) { h2.push(app, "Move part.stl X", 1200); m.offset[0] += 10; }
  assert.equal(h2.undoStack.length, 1);
  h2.undo(app);
  assert.equal(m.offset[0], 120);
});
