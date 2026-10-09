// bodies.js - one view of everything that sits on the Tile: the built-in cubes and
// disks (SceneObject: pos = centre of the bottom face) and imported models
// (ModelItem: offset + yaw, triangles in a local frame with the lowest point at
// z = 0). Used for stacking, "snap to surface", overlap checks and the magnet.
// Geometry questions about models go through their BVH (mesh_bvh.js), so a pallet
// with slots or an L-shaped part behaves like its real shape, not its box.
import { MeshBVH } from "./mesh_bvh.js";

const DEG = Math.PI / 180;
export const isModel = (b) => Array.isArray(b.offset);

// ------------------------------------------------------------- transforms ---
export function yawOf(b) { return isModel(b) ? (b.yaw || 0) : 0; }
export function origin(b) { return isModel(b) ? b.offset : b.pos; }
export function setOrigin(b, p) { const o = origin(b); o[0] = p[0]; o[1] = p[1]; o[2] = p[2]; }
export function worldToLocal(m, p) {
  const a = -yawOf(m) * DEG, c = Math.cos(a), s = Math.sin(a);
  const x = p[0] - m.offset[0], y = p[1] - m.offset[1];
  return [c * x - s * y, s * x + c * y, p[2] - m.offset[2]];
}
export function localToWorld(m, p) {
  const a = yawOf(m) * DEG, c = Math.cos(a), s = Math.sin(a);
  return [m.offset[0] + c * p[0] - s * p[1], m.offset[1] + s * p[0] + c * p[1], m.offset[2] + p[2]];
}
export function bvh(m) { if (!m._bvh) m._bvh = new MeshBVH(m.positions); return m._bvh; }

// ----------------------------------------------------------------- bounds ---
/** World axis-aligned bounds [lo, hi]. */
export function aabb(b) {
  if (!isModel(b)) {
    const h = b.size / 2, p = b.pos;
    return [[p[0] - h, p[1] - h, p[2]], [p[0] + h, p[1] + h, p[2] + b.height]];
  }
  const a = yawOf(b) * DEG, c = Math.cos(a), s = Math.sin(a);
  const lo = [Infinity, Infinity, b.offset[2] + b.lo[2]], hi = [-Infinity, -Infinity, b.offset[2] + b.hi[2]];
  for (const x of [b.lo[0], b.hi[0]]) for (const y of [b.lo[1], b.hi[1]]) {
    const wx = b.offset[0] + c * x - s * y, wy = b.offset[1] + s * x + c * y;
    lo[0] = Math.min(lo[0], wx); hi[0] = Math.max(hi[0], wx); lo[1] = Math.min(lo[1], wy); hi[1] = Math.max(hi[1], wy);
  }
  return [lo, hi];
}
/** Half extents of the footprint around the origin (for platform clamping). */
export function halfSize(b) {
  if (!isModel(b)) return [b.size / 2, b.size / 2];
  const [lo, hi] = aabb(b);
  return [Math.max(b.offset[0] - lo[0], hi[0] - b.offset[0]), Math.max(b.offset[1] - lo[1], hi[1] - b.offset[1])];
}
export function bottomZ(b) { return isModel(b) ? b.offset[2] + b.lo[2] : b.pos[2]; }
export function topZ(b) { return isModel(b) ? b.offset[2] + b.hi[2] : b.pos[2] + b.height; }
export function setBottomZ(b, z) { if (isModel(b)) b.offset[2] = z - b.lo[2]; else b.pos[2] = z; }
export function center(b) { const [lo, hi] = aabb(b); return lo.map((v, k) => (v + hi[k]) / 2); }

// ------------------------------------------------------------ solid spans ---
/** Solid [bottom, top] spans (world z) of the body on the vertical line (x, y). */
export function intervals(b, x, y) {
  if (!isModel(b)) {
    const h = b.size / 2, dx = x - b.pos[0], dy = y - b.pos[1];
    const inside = b.kind === "disk" ? dx * dx + dy * dy <= h * h : Math.abs(dx) <= h && Math.abs(dy) <= h;
    return inside ? [[b.pos[2], b.pos[2] + b.height]] : [];
  }
  const l = worldToLocal(b, [x, y, 0]);
  return bvh(b).intervals(l[0], l[1]).map(([z0, z1]) => [z0 + b.offset[2], z1 + b.offset[2]]);
}
export function topAt(b, x, y) { const iv = intervals(b, x, y); return iv.length ? iv[iv.length - 1][1] : null; }

/** Distance from a world point to the body's surface (0 inside). */
export function pointDistance(b, p, maxDist = Infinity) {
  if (isModel(b)) return bvh(b).pointDistance(worldToLocal(b, p), maxDist);
  const h = b.size / 2;
  const dz = Math.max(b.pos[2] - p[2], 0, p[2] - b.pos[2] - b.height);
  if (b.kind === "disk") {
    const dr = Math.max(0, Math.hypot(p[0] - b.pos[0], p[1] - b.pos[1]) - h);
    return Math.hypot(dr, dz);
  }
  const dx = Math.max(b.pos[0] - h - p[0], 0, p[0] - b.pos[0] - h), dy = Math.max(b.pos[1] - h - p[1], 0, p[1] - b.pos[1] - h);
  return Math.hypot(dx, dy, dz);
}

// ---------------------------------------------------------------- samples ---
/** Points of the body's footprint where it has material, with its solid spans there
 *  (local coordinates for models, cached; world for cubes / disks). */
function localSamples(b) {
  if (!isModel(b)) {
    const h = b.size / 2, out = [];
    const n = b.kind === "disk" ? 8 : 3;
    if (b.kind === "disk") {
      out.push({ x: 0, y: 0 });
      for (let i = 0; i < n; i++) out.push({ x: Math.cos(i / n * 2 * Math.PI) * h * 0.95, y: Math.sin(i / n * 2 * Math.PI) * h * 0.95 });
    } else {
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push({ x: (i / (n - 1) - 0.5) * 2 * h * 0.96, y: (j / (n - 1) - 0.5) * 2 * h * 0.96 });
    }
    return out.map((s) => ({ ...s, spans: [[0, b.height]] }));
  }
  if (b._samples) return b._samples;
  const sx = b.hi[0] - b.lo[0], sy = b.hi[1] - b.lo[1];
  const step = Math.max(2.5, Math.max(sx, sy) / 14);
  const nx = Math.max(2, Math.ceil(sx / step)), ny = Math.max(2, Math.ceil(sy / step));
  const out = [];
  const q = bvh(b);
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) {
    const x = b.lo[0] + (i / nx) * sx * 0.995 + sx * 0.0025, y = b.lo[1] + (j / ny) * sy * 0.995 + sy * 0.0025;
    const spans = q.intervals(x, y);
    if (spans.length) out.push({ x, y, spans });
  }
  if (!out.length) out.push({ x: (b.lo[0] + b.hi[0]) / 2, y: (b.lo[1] + b.hi[1]) / 2, spans: [[b.lo[2], b.hi[2]]] });
  b._samples = out;
  return out;
}
/** World-space samples: [{x, y, spans: [[z0, z1], ...]}] */
export function samples(b) {
  const loc = localSamples(b);
  if (!isModel(b)) return loc.map((s) => ({ x: b.pos[0] + s.x, y: b.pos[1] + s.y, spans: s.spans.map(([a, c]) => [a + b.pos[2], c + b.pos[2]]) }));
  const a = yawOf(b) * DEG, c = Math.cos(a), sn = Math.sin(a);
  return loc.map((s) => ({ x: b.offset[0] + c * s.x - sn * s.y, y: b.offset[1] + sn * s.x + c * s.y, spans: s.spans.map(([z0, z1]) => [z0 + b.offset[2], z1 + b.offset[2]]) }));
}
export function invalidateSamples(b) { if (isModel(b)) { b._samples = null; } }

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

/** Lowest/highest point and the top surface right under a world point (for the magnet). */
export function topUnder(b, p) {
  const iv = intervals(b, p[0], p[1]);
  let best = null;
  for (const [, z1] of iv) if (z1 <= p[2] + 3 && (best === null || z1 > best)) best = z1;
  return best;
}
