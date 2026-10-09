// bodies.js - one view of everything that sits on the Tile: the built-in cubes and
// disks (SceneObject: pos = centre of the bottom face) and imported models
// (ModelItem: offset = where the model's local origin is). Every body can be
// rotated about X, Y and Z (`rot` = Euler angles in degrees, applied X then Y
// then Z about the world axes, R = Rz * Ry * Rx). All geometry questions - bounds,
// what is solid on a vertical line, resting height, overlap, nearest surface -
// go through a triangle mesh + BVH (mesh_bvh.js): the model's own triangles, or
// a generated box / cylinder for cubes and disks. So a pallet with slots or a
// tilted part behaves like its real shape, not its bounding box.
import { MeshBVH } from "./mesh_bvh.js";

const DEG = Math.PI / 180;
export const isModel = (b) => Array.isArray(b.offset);
export const origin = (b) => (isModel(b) ? b.offset : b.pos);
export function setOrigin(b, p) { const o = origin(b); o[0] = p[0]; o[1] = p[1]; o[2] = p[2]; b._samples = null; }

// ------------------------------------------------------------- 3x3 matrices ---
export const I3 = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
export const mul3 = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
export const transpose3 = (a) => [0, 1, 2].map((i) => [a[0][i], a[1][i], a[2][i]]);
export const apply3 = (m, v) => [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];
export function axisRotation(axis, deg) {
  const a = deg * DEG, c = Math.cos(a), s = Math.sin(a);
  if (axis === "x") return [[1, 0, 0], [0, c, -s], [0, s, c]];
  if (axis === "y") return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}
/** Euler [rx, ry, rz] (degrees, X then Y then Z about the world axes) -> matrix. */
export function matrixFromEuler(r) { return mul3(axisRotation("z", r[2]), mul3(axisRotation("y", r[1]), axisRotation("x", r[0]))); }
/** Matrix -> Euler [rx, ry, rz] in degrees (ry in -90..90), inverse of matrixFromEuler. */
export function eulerFromMatrix(R) {
  const sy = -R[2][0];
  const ry = Math.asin(Math.max(-1, Math.min(1, sy)));
  let rx, rz;
  if (Math.abs(sy) < 1 - 1e-9) { rx = Math.atan2(R[2][1], R[2][2]); rz = Math.atan2(R[1][0], R[0][0]); }
  else { rx = Math.atan2(-R[1][2], R[1][1]); rz = 0; }               // gimbal lock: put everything in rx
  return [rx, ry, rz].map((v) => wrapDeg(v / DEG));
}
export const wrapDeg = (a) => { const w = ((a + 180) % 360 + 360) % 360 - 180; return Object.is(w, -0) || Math.abs(w) < 1e-9 ? 0 : w; };
/** Rotation of a body as Euler degrees (always a 3-array). */
export function rot(b) { if (!b.rot) b.rot = [0, 0, 0]; return b.rot; }
export const yawOf = (b) => rot(b)[2];
export const isRotated = (b) => rot(b).some((v) => Math.abs(v) > 1e-9);
export function rotationMatrix(b) {
  const r = rot(b), key = r.join(",");
  if (b._rotKey !== key) { b._R = matrixFromEuler(r); b._Rt = transpose3(b._R); b._rotKey = key; b._samples = null; b._aabb = null; }
  return b._R;
}
export function worldToLocal(b, p) { rotationMatrix(b); const o = origin(b); return apply3(b._Rt, [p[0] - o[0], p[1] - o[1], p[2] - o[2]]); }
export function localToWorld(b, p) { const R = rotationMatrix(b), o = origin(b), w = apply3(R, p); return [w[0] + o[0], w[1] + o[1], w[2] + o[2]]; }

// ------------------------------------------------------------------ shapes ---
function boxTriangles(lo, hi) {
  const v = (x, y, z) => [x ? hi[0] : lo[0], y ? hi[1] : lo[1], z ? hi[2] : lo[2]];
  const quad = (a, b, c, d) => [a, b, c, a, c, d];
  return [
    ...quad(v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)), ...quad(v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)),
    ...quad(v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)), ...quad(v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)),
    ...quad(v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)), ...quad(v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)),
  ].flat();
}
function cylinderTriangles(r, h, n = 24) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * 2 * Math.PI, a1 = ((i + 1) / n) * 2 * Math.PI;
    const x0 = r * Math.cos(a0), y0 = r * Math.sin(a0), x1 = r * Math.cos(a1), y1 = r * Math.sin(a1);
    out.push(0, 0, 0, x1, y1, 0, x0, y0, 0);                 // bottom (facing down)
    out.push(0, 0, h, x0, y0, h, x1, y1, h);                 // top
    out.push(x0, y0, 0, x1, y1, 0, x1, y1, h, x0, y0, 0, x1, y1, h, x0, y0, h);   // side
  }
  return out;
}
/** Local shape of a body: { bvh, lo, hi } in its own frame (origin = bottom centre). */
export function shape(b) {
  if (isModel(b)) { if (!b._bvh) b._bvh = new MeshBVH(b.positions); return { bvh: b._bvh, lo: b.lo, hi: b.hi }; }
  const key = `${b.kind}|${b.size}|${b.height}`;
  if (b._shapeKey !== key) {
    const h = b.size / 2;
    const tris = b.kind === "disk" ? cylinderTriangles(h, b.height) : boxTriangles([-h, -h, 0], [h, h, b.height]);
    b._shape = { bvh: new MeshBVH(Float32Array.from(tris)), lo: [-h, -h, 0], hi: [h, h, b.height] };
    b._shapeKey = key; b._samples = null; b._aabb = null;
  }
  return b._shape;
}
export function bvh(b) { return shape(b).bvh; }
const transformKey = (b) => `${rot(b).join(",")}|${origin(b).join(",")}|${isModel(b) ? "" : b.size + "," + b.height}`;

// ----------------------------------------------------------------- bounds ---
/** World axis-aligned bounds [lo, hi] (the rotated local box). */
export function aabb(b) {
  const key = transformKey(b);
  if (b._aabb && b._aabbKey === key) return b._aabb;
  const s = shape(b), R = rotationMatrix(b), o = origin(b);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const x of [s.lo[0], s.hi[0]]) for (const y of [s.lo[1], s.hi[1]]) for (const z of [s.lo[2], s.hi[2]]) {
    const w = apply3(R, [x, y, z]);
    for (let k = 0; k < 3; k++) { const v = w[k] + o[k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
  }
  b._aabb = [lo, hi]; b._aabbKey = key;
  return b._aabb;
}
/** Half extents of the footprint around the origin (for platform clamping). */
export function halfSize(b) { const [lo, hi] = aabb(b), o = origin(b); return [Math.max(o[0] - lo[0], hi[0] - o[0]), Math.max(o[1] - lo[1], hi[1] - o[1])]; }
export function bottomZ(b) { return aabb(b)[0][2]; }
export function topZ(b) { return aabb(b)[1][2]; }
export function setBottomZ(b, z) { origin(b)[2] += z - bottomZ(b); b._samples = null; b._aabb = null; }
export function center(b) { const [lo, hi] = aabb(b); return lo.map((v, k) => (v + hi[k]) / 2); }

/** Set the rotation (Euler degrees), turning the body about its bounding-box centre so
 *  it stays in place, and lift it if a corner went below the Tile. */
export function setRotation(b, r) {
  const c0 = center(b);
  b.rot = r.map(wrapDeg);
  b._samples = null; b._aabb = null;
  const c1 = center(b), o = origin(b);
  setOrigin(b, [o[0] + c0[0] - c1[0], o[1] + c0[1] - c1[1], o[2] + c0[2] - c1[2]]);
  b._aabb = null;
  if (bottomZ(b) < 0) setBottomZ(b, 0);
}
/** Rotate by `deg` about a world axis through the body's centre. */
export function rotateAbout(b, axis, deg) { setRotation(b, eulerFromMatrix(mul3(axisRotation(axis, deg), rotationMatrix(b)))); }
export function setRotationMatrix(b, R) { setRotation(b, eulerFromMatrix(R)); }

// ------------------------------------------------------------ solid spans ---
/** Solid [bottom, top] spans (world z) of the body on the vertical line (x, y). */
export function intervals(b, x, y) {
  const [lo, hi] = aabb(b);
  if (x < lo[0] - 1e-6 || x > hi[0] + 1e-6 || y < lo[1] - 1e-6 || y > hi[1] + 1e-6) return [];
  const o = worldToLocal(b, [x, y, 0]);
  const d = apply3(b._Rt, [0, 0, 1]);                       // the world's up, seen from the body
  return bvh(b).lineIntervals(o, d);                        // t along a unit "up" from z = 0 is the world z
}
export function topAt(b, x, y) { const iv = intervals(b, x, y); return iv.length ? iv[iv.length - 1][1] : null; }

/** Distance from a world point to the body's surface (0 inside). */
export function pointDistance(b, p, maxDist = Infinity) { return bvh(b).pointDistance(worldToLocal(b, p), maxDist); }

// ---------------------------------------------------------------- samples ---
/** Points of the body's world footprint where it has material, with its solid spans
 *  there: [{x, y, spans: [[z0, z1], ...]}]. Cached until the body moves or turns. */
export function samples(b) {
  const key = transformKey(b);
  if (b._samples && b._samplesKey === key) return b._samples;
  const [lo, hi] = aabb(b);
  const sx = hi[0] - lo[0], sy = hi[1] - lo[1];
  const step = Math.max(2.5, Math.max(sx, sy) / 14);
  const nx = Math.max(2, Math.ceil(sx / step)), ny = Math.max(2, Math.ceil(sy / step));
  const out = [];
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) {
    const x = lo[0] + (i / nx) * sx * 0.995 + sx * 0.0025, y = lo[1] + (j / ny) * sy * 0.995 + sy * 0.0025;
    const spans = intervals(b, x, y);
    if (spans.length) out.push({ x, y, spans });
  }
  if (!out.length) out.push({ x: (lo[0] + hi[0]) / 2, y: (lo[1] + hi[1]) / 2, spans: [[lo[2], hi[2]]] });
  // the grid can miss the very lowest point of a tilted body: add its lowest corner(s) as point contacts
  const sh = shape(b), R = rotationMatrix(b), o = origin(b);
  for (const x of [sh.lo[0], sh.hi[0]]) for (const y of [sh.lo[1], sh.hi[1]]) for (const z of [sh.lo[2], sh.hi[2]]) {
    const w = apply3(R, [x, y, z]).map((v, k) => v + o[k]);
    if (w[2] < lo[2] + 0.5) out.push({ x: w[0], y: w[1], spans: [[w[2], w[2]]], corner: true });
  }
  b._samples = out; b._samplesKey = key;
  return out;
}
export function invalidateSamples(b) { b._samples = null; b._aabb = null; }

// -------------------------------------------------------- resting / overlap ---
const supportsOf = (b, others) => others.filter((o) => o !== b && !o.held);
const boxesTouch = (A, B, eps) => A[0].every((v, k) => v < B[1][k] + eps) && B[0].every((v, k) => v < A[1][k] + eps);

/** The origin z at which `b` rests on the Tile or on the other bodies.
 *  fromAbove: drop it from high up (snap-to-surface); otherwise let it fall from
 *  where it is onto the first surface below (gravity), never rising. */
export function dropZ(b, others, { fromAbove = false, eps = 0.5 } = {}) {
  const sup = supportsOf(b, others);
  const [lo, hi] = aabb(b);
  const near = sup.filter((o) => { const [olo, ohi] = aabb(o); return olo[0] < hi[0] + eps && ohi[0] > lo[0] - eps && olo[1] < hi[1] + eps && ohi[1] > lo[1] - eps; });
  let fall = Infinity;
  for (const s of samples(b)) {
    const zb = Math.min(...s.spans.map((sp) => sp[0]));        // this body's underside here
    let top = 0;                                                // the Tile
    for (const o of near) for (const [z0, z1] of intervals(o, s.x, s.y)) {
      if (fromAbove || z1 <= zb + eps) top = Math.max(top, z1);
      else if (z0 < zb) top = Math.max(top, zb);              // already embedded here: gravity does not pull it through
    }
    fall = Math.min(fall, zb - top);
  }
  if (!Number.isFinite(fall)) fall = bottomZ(b);
  fall = Math.min(fall, bottomZ(b));                             // the lowest point never goes under the Tile
  if (!fromAbove) fall = Math.max(0, fall);
  return origin(b)[2] - fall;
}

/** Do two bodies occupy the same space (solid spans crossing at some footprint point)? */
export function overlaps(a, b, eps = 0.5) {
  if (!boxesTouch(aabb(a), aabb(b), -eps)) return false;
  const check = (p, q) => {
    for (const s of samples(p)) {
      const qs = intervals(q, s.x, s.y);
      if (!qs.length) continue;
      for (const [a0, a1] of s.spans) for (const [b0, b1] of qs) if (a0 < b1 - eps && b0 < a1 - eps) return true;
    }
    return false;
  };
  return check(a, b) || check(b, a);
}
export function overlapping(b, others, eps = 0.5) { return others.filter((o) => o !== b && !o.held && overlaps(b, o, eps)); }

/** The top surface right under a world point (for the magnet), or null. */
export function topUnder(b, p) {
  const iv = intervals(b, p[0], p[1]);
  let best = null;
  for (const [, z1] of iv) if (z1 <= p[2] + 3 && (best === null || z1 > best)) best = z1;
  return best;
}
