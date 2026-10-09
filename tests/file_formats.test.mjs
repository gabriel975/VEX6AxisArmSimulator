// Model file readers and file-type detection (js/file_formats.js, js/model_library.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as fflate from "../vendor/three/addons/fflate.module.js";
import * as ff from "../js/file_formats.js";
import { ModelItem, MAX_SIZE } from "../js/model_library.js";
import { asciiSTL, binarySTL, cube, simple3MF, production3MF, translate, mirrorX, signedVolume, sizeOf, bounds } from "./fixtures.mjs";

const models = new URL("../models/", import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, models));
const near = (a, b, tol = 1e-3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test("bundled models parse with the expected sizes", () => {
  const expect = { "cube.stl": [25, 25, 25], "disk.stl": [30, 30, 8], "test_cube.stl": [40, 40, 40], "test_cylinder.stl": [40, 40, 60], "test_pallet.3mf": [90, 60, 14] };
  for (const [f, size] of Object.entries(expect)) {
    const r = ff.parseModelBytes(read(f), f);
    assert.ok(near(sizeOf(r.positions), size, 0.01), `${f}: ${sizeOf(r.positions)}`);
    assert.equal(r.positions.length % 9, 0);
    assert.equal(r.fmt, f.endsWith(".3mf") ? "3MF" : "STL");
  }
});

test("ASCII and binary STL give the same triangles", () => {
  const tris = cube(25);
  const a = ff.parseSTL(asciiSTL(tris)), b = ff.parseSTL(binarySTL(tris));
  assert.equal(ff.sniffModel(asciiSTL(tris)), "stl-ascii");
  assert.equal(ff.sniffModel(binarySTL(tris)), "stl-binary");
  assert.equal(a.length, 12 * 9);
  assert.deepEqual([...a], [...b]);
  assert.ok(signedVolume(a) > 0 && Math.abs(signedVolume(a) - 25 ** 3) < 1e-6, "volume " + signedVolume(a));
});

test("binary STL whose header starts with 'solid' is still read as binary", () => {
  const b = binarySTL(cube(10), "solid exported by some CAD tool");
  assert.equal(ff.sniffModel(b), "stl-binary");
  assert.equal(ff.parseSTL(b).length, 108);
});

test("ASCII STL with Windows line endings, a BOM and odd spacing", () => {
  const text = "\uFEFFsolid  part\r\n" + "facet normal 0 0 1\r\nouter loop\r\n vertex 0 0 0\r\n\tvertex 1.5e+00 0 0\r\nvertex 0 2.5 0\r\nendloop\r\nendfacet\r\nendsolid part\r\n";
  const p = ff.parseSTL(new TextEncoder().encode(text));
  assert.deepEqual([...p], [0, 0, 0, 1.5, 0, 0, 0, 2.5, 0]);
});

test("junk is rejected with a friendly message", () => {
  assert.throws(() => ff.parseSTL(new Uint8Array([1, 2, 3, 4, 5])), /not an STL/);
  assert.throws(() => ff.parse3MF(new TextEncoder().encode("hello")), /zip/);
  assert.throws(() => ff.parseModelBytes(new TextEncoder().encode("{}"), "x.json"), /only .stl and .3mf/);
  assert.throws(() => ff.parseModelBytes(new TextEncoder().encode("not a model"), "x.stl"), /not an STL/);
  assert.equal(ff.parseModelBytes(read("test_pallet.3mf"), "renamed.stl").fmt, "3MF", "content wins over a wrong extension");
});

test("plain 3MF: build transforms, units and winding", () => {
  const mm = ff.parse3MF(simple3MF({ objects: [{ id: 1, tris: cube(10) }], items: [{ objectId: 1 }, { objectId: 1, transform: translate(30, 0, 0) }] }));
  assert.equal(mm.items, 2);
  assert.ok(near(sizeOf(mm.positions), [40, 10, 10]), "two cubes 30 apart: " + sizeOf(mm.positions));
  const inch = ff.parse3MF(simple3MF({ unit: "inch", objects: [{ id: 1, tris: cube(1) }], items: [{ objectId: 1 }] }));
  assert.ok(near(sizeOf(inch.positions), [25.4, 25.4, 25.4]), "inch cube " + sizeOf(inch.positions));
  assert.equal(inch.unitScale, 25.4);
  const notes = ff.parseModelBytes(simple3MF({ unit: "inch", objects: [{ id: 1, tris: cube(1) }], items: [{ objectId: 1 }] }), "a.3mf").notes;
  assert.ok(notes.some((n) => /inch/.test(n)), notes.join("; "));
  const mirrored = ff.parse3MF(simple3MF({ objects: [{ id: 1, tris: cube(10) }], items: [{ objectId: 1, transform: mirrorX(20) }] }));
  assert.ok(signedVolume(mirrored.positions) > 0, "mirrored build item must keep outward faces: " + signedVolume(mirrored.positions));
  assert.ok(near(bounds(mirrored.positions)[0], [10, 0, 0]) && near(bounds(mirrored.positions)[1], [20, 10, 10]), JSON.stringify(bounds(mirrored.positions)));
});

test("production-extension 3MF (Bambu / PrusaSlicer): objects in 3D/Objects/*.model with repeated ids", () => {
  const file = production3MF({
    parts: [{ tris: cube(10), name: "small" }, { tris: cube(20), name: "big", componentTransform: translate(0, 0, 5) }, { tris: cube(5) }],
    build: [{ part: 0, transform: translate(0, 0, 0) }, { part: 1, transform: translate(50, 0, 0) }, { part: 2, transform: translate(0, 40, 0) }],
  });
  assert.equal(ff.sniffModel(file), "3mf");
  assert.equal(ff.detectFileKind("print.3mf", file), "model");
  const r = ff.parse3MF(file);
  assert.equal(r.items, 3);
  assert.equal(r.parts, 4, "root + 3 object parts");
  assert.equal(r.triangles, 36);
  const [lo, hi] = bounds(r.positions);
  // small cube at 0..10, big cube at x 50..70 and z 5..25 (component + build transform), tiny cube at y 40..45
  assert.ok(near(lo, [0, 0, 0]) && near(hi, [70, 45, 25]), JSON.stringify([lo, hi]));
  assert.ok(Math.abs(signedVolume(r.positions) - (1000 + 8000 + 125)) < 1e-3, "volume " + signedVolume(r.positions));
  assert.deepEqual(r.warnings, []);
  const notes = ff.parseModelBytes(file, "print.3mf").notes;
  assert.ok(notes.some((n) => /3 objects/.test(n)), notes.join("; "));
});

test("3MF without a <build> still shows its top-level objects", () => {
  const file = simple3MF({ objects: [{ id: 7, tris: cube(10) }], items: [] });
  const r = ff.parse3MF(file);
  assert.equal(r.triangles, 12);
  assert.ok(r.warnings.some((w) => /no build/.test(w)));
});

test("3MF objects of type support / other are skipped", () => {
  const file = simple3MF({ objects: [{ id: 1, tris: cube(10) }, { id: 2, type: "support", tris: cube(100) }], items: [{ objectId: 1 }, { objectId: 2 }] });
  assert.ok(near(sizeOf(ff.parse3MF(file).positions), [10, 10, 10]));
});

test("transform maths: compose and apply follow the 3MF row-vector convention", () => {
  const T = ff.parseTransform("0 1 0 -1 0 0 0 0 1 10 20 30");      // rotate 90 deg about z, then translate
  assert.deepEqual(ff.applyTransform(T, 1, 0, 0), [10, 21, 30]);
  const S = ff.parseTransform(translate(5, 0, 0));
  assert.deepEqual(ff.applyTransform(ff.mulTransform(T, S), 1, 0, 0), ff.applyTransform(T, ...ff.applyTransform(S, 1, 0, 0)));
  assert.equal(ff.parseTransform("1 2 3"), null);
});

test("detectFileKind: extension first, then content", () => {
  const scene = new TextEncoder().encode('{"format": "six-axis-arm-scene", "objects": []}');
  const project = new TextEncoder().encode('{"mode":"Text","textContent":"from cte import *\\n"}');
  assert.equal(ff.detectFileKind("part.STL"), "model");
  assert.equal(ff.detectFileKind("part.3mf"), "model");
  assert.equal(ff.detectFileKind("my_scene.json", scene), "scene");
  assert.equal(ff.detectFileKind("my_scene.json"), "scene");
  assert.equal(ff.detectFileKind("saved.json", project), "program", "a VEXcode project saved as .json is a program");
  assert.equal(ff.detectFileKind("x.ctepython"), "program");
  assert.equal(ff.detectFileKind("x.py", new TextEncoder().encode("print(1)")), "program");
  assert.equal(ff.detectFileKind("renamed.dat", read("test_pallet.3mf")), "model", "content sniffing: 3MF");
  assert.equal(ff.detectFileKind("renamed.dat", read("cube.stl")), "model", "content sniffing: binary STL");
  assert.equal(ff.detectFileKind("renamed.txt", asciiSTL(cube(1))), "model", "content sniffing beats a program extension for an STL");
  assert.equal(ff.detectFileKind("renamed", scene), "scene");
  assert.equal(ff.detectFileKind("prog", new TextEncoder().encode("from cte import *\narm = Arm()\n")), "program");
  assert.equal(ff.detectFileKind("photo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])), null);
  const docx = fflate.zipSync({ "word/document.xml": new TextEncoder().encode("<w/>") });
  assert.equal(ff.sniffModel(docx), null);
  assert.equal(ff.detectFileKind("notes.docx", docx), null, "a zip that is not a 3MF");
});

test("ModelItem: placed on the floor, centred, auto-scaled with a note", () => {
  const plain = new ModelItem("c.stl", "STL", ff.parseSTL(binarySTL(cube(25, [100, 100, 7]))), { data: 1 });
  assert.deepEqual(plain.size(), [25, 25, 25]);
  assert.ok(near(plain.lo, [-12.5, -12.5, 0]) && near(plain.hi, [12.5, 12.5, 25]), JSON.stringify([plain.lo, plain.hi]));
  assert.equal(plain.autoScale, 1);
  assert.deepEqual(plain.notes, []);
  const meters = new ModelItem("m.stl", "STL", ff.parseSTL(binarySTL(cube(0.025))), { data: 1 });
  assert.ok(near(meters.size(), [25, 25, 25], 1e-4), "meters -> mm " + meters.size());
  assert.equal(meters.autoScale, 1000);
  assert.match(meters.notes[0], /meters/);
  const huge = new ModelItem("h.stl", "STL", ff.parseSTL(binarySTL(cube(1200))), { data: 1 });
  assert.ok(near(huge.size(), [MAX_SIZE, MAX_SIZE, MAX_SIZE], 1e-3), "scaled down " + huge.size());
  assert.match(huge.notes[0], /1200 mm/);
  const scaled = new ModelItem("s.stl", "STL", ff.parseSTL(binarySTL(cube(10))), { data: 1 }, 2);
  assert.ok(near(scaled.size(), [20, 20, 20]), "user scale " + scaled.size());
  assert.throws(() => new ModelItem("z.stl", "STL", new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]), { data: 1 }), /no size/);
});

test("3MF parser handles a big mesh quickly", () => {
  const tris = [];
  for (let i = 0; i < 200; i++) for (let j = 0; j < 100; j++) tris.push(...cube(0.5, [i, j, 0]));   // 240k triangles
  const file = simple3MF({ objects: [{ id: 1, tris }], items: [{ objectId: 1 }] });
  const t0 = Date.now();
  const r = ff.parse3MF(file);
  const ms = Date.now() - t0;
  assert.equal(r.triangles, tris.length);
  assert.ok(ms < 15000, `took ${ms} ms`);
});
