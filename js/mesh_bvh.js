// mesh_bvh.js - a small bounding-volume hierarchy over a triangle soup, so the
// simulator can ask real-geometry questions about imported STL / 3MF models:
//   pointDistance(p, maxDist)  nearest distance from a point to the mesh surface
//   verticalHits(x, y)         z values where the vertical line (x, y) crosses the mesh
//   intervals(x, y)            solid [bottom, top] spans at (x, y) (even-odd rule)
// Pure JavaScript, mm units, model-local coordinates. Built once per model.

const LEAF = 8;

export class MeshBVH {
  /** positions: Float32Array of triangle vertices, 9 numbers per triangle. */
  constructor(positions) {
    this.p = positions;
    const n = positions.length / 9;
    this.n = n;
    this.tris = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.tris[i] = i;
    const cen = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) cen[i * 3 + k] = (positions[i * 9 + k] + positions[i * 9 + 3 + k] + positions[i * 9 + 6 + k]) / 3;
    this.cen = cen;
    this.nodes = [];                       // {lo, hi, left, right, start, count}
    this.root = n ? this.build(0, n) : -1;
    this.lo = n ? this.nodes[this.root].lo : [0, 0, 0];
    this.hi = n ? this.nodes[this.root].hi : [0, 0, 0];
  }

  build(start, count) {
    const p = this.p, tris = this.tris;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const clo = [Infinity, Infinity, Infinity], chi = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < start + count; i++) {
      const t = tris[i];
      for (let v = 0; v < 9; v += 3) for (let k = 0; k < 3; k++) { const x = p[t * 9 + v + k]; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; }
      for (let k = 0; k < 3; k++) { const c = this.cen[t * 3 + k]; if (c < clo[k]) clo[k] = c; if (c > chi[k]) chi[k] = c; }
    }
    const id = this.nodes.length;
    const node = { lo, hi, left: -1, right: -1, start, count };
    this.nodes.push(node);
    if (count <= LEAF) return id;
    let axis = 0;
    for (let k = 1; k < 3; k++) if (chi[k] - clo[k] > chi[axis] - clo[axis]) axis = k;
    if (chi[axis] - clo[axis] < 1e-9) return id;              // all centroids coincide: leave as a (big) leaf
    // median split on the centroid along the longest axis (partial sort of this range)
    const sub = Array.from(tris.subarray(start, start + count));
    const cen = this.cen;
    sub.sort((a, b) => cen[a * 3 + axis] - cen[b * 3 + axis]);
    for (let i = 0; i < count; i++) tris[start + i] = sub[i];
    const mid = start + (count >> 1);
    node.left = this.build(start, mid - start);
    node.right = this.build(mid, start + count - mid);
    node.count = 0;
    return id;
  }

  // ----------------------------------------------------------- queries ---
  /** Distance from p to the mesh surface, or Infinity if it is more than maxDist away. */
  pointDistance(p, maxDist = Infinity) {
    if (this.root < 0) return Infinity;
    let best = maxDist;
    const stack = [this.root];
    while (stack.length) {
      const node = this.nodes[stack.pop()];
      if (boxDistance(node.lo, node.hi, p) >= best) continue;
      if (node.left < 0) {
        for (let i = node.start; i < node.start + node.count; i++) {
          const d = this.triDistance(this.tris[i], p);
          if (d < best) best = d;
        }
      } else {
        // nearer child first
        const a = this.nodes[node.left], b = this.nodes[node.right];
        if (boxDistance(a.lo, a.hi, p) < boxDistance(b.lo, b.hi, p)) { stack.push(node.right, node.left); } else { stack.push(node.left, node.right); }
      }
    }
    return best;
  }

  /** z of every crossing of the vertical line through (x, y), sorted ascending. */
  verticalHits(x, y) {
    const out = [];
    if (this.root < 0) return out;
    const stack = [this.root];
    const p = this.p;
    while (stack.length) {
      const node = this.nodes[stack.pop()];
      if (x < node.lo[0] - 1e-6 || x > node.hi[0] + 1e-6 || y < node.lo[1] - 1e-6 || y > node.hi[1] + 1e-6) continue;
      if (node.left < 0) {
        for (let i = node.start; i < node.start + node.count; i++) {
          const t = this.tris[i] * 9;
          const z = triVertical(p, t, x, y);
          if (z !== null) out.push(z);
        }
      } else stack.push(node.left, node.right);
    }
    out.sort((a, b) => a - b);
    // the same edge shared by two triangles can be hit twice: merge near-duplicates
    const merged = [];
    for (const z of out) if (!merged.length || z - merged[merged.length - 1] > 1e-4) merged.push(z);
    return merged;
  }

  /** Solid spans [bottom, top] at (x, y). Even-odd on a watertight mesh; otherwise one span min..max. */
  intervals(x, y) {
    const zs = this.verticalHits(x, y);
    if (!zs.length) return [];
    if (zs.length % 2) return [[zs[0], zs[zs.length - 1]]];
    const out = [];
    for (let i = 0; i < zs.length; i += 2) out.push([zs[i], zs[i + 1]]);
    return out;
  }

  triDistance(t, p) {
    const a = t * 9;
    return pointTriangleDistance(p, this.p, a);
  }
}

function boxDistance(lo, hi, p) {
  let s = 0;
  for (let k = 0; k < 3; k++) { const d = Math.max(lo[k] - p[k], 0, p[k] - hi[k]); s += d * d; }
  return Math.sqrt(s);
}

/** z where the vertical line (x, y) crosses triangle at positions[a..a+9), or null. */
function triVertical(P, a, x, y) {
  const x0 = P[a], y0 = P[a + 1], x1 = P[a + 3], y1 = P[a + 4], x2 = P[a + 6], y2 = P[a + 7];
  const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
  if (Math.abs(d) < 1e-9) return null;                        // vertical / degenerate triangle: no top or bottom here
  const l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / d;
  const l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / d;
  const l2 = 1 - l0 - l1;
  const e = -1e-6;
  if (l0 < e || l1 < e || l2 < e) return null;
  return l0 * P[a + 2] + l1 * P[a + 5] + l2 * P[a + 8];
}

/** Closest-point-on-triangle distance (Ericson, Real-Time Collision Detection 5.1.5). */
export function pointTriangleDistance(p, P, a) {
  const ax = P[a], ay = P[a + 1], az = P[a + 2], bx = P[a + 3], by = P[a + 4], bz = P[a + 5], cx = P[a + 6], cy = P[a + 7], cz = P[a + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return Math.hypot(apx, apy, apz);
  const bpx = p[0] - bx, bpy = p[1] - by, bpz = p[2] - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bpx, bpy, bpz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return Math.hypot(p[0] - (ax + v * abx), p[1] - (ay + v * aby), p[2] - (az + v * abz)); }
  const cpx = p[0] - cx, cpy = p[1] - cy, cpz = p[2] - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cpx, cpy, cpz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return Math.hypot(p[0] - (ax + w * acx), p[1] - (ay + w * acy), p[2] - (az + w * acz)); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return Math.hypot(p[0] - (bx + w * (cx - bx)), p[1] - (by + w * (cy - by)), p[2] - (bz + w * (cz - bz)));
  }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  return Math.hypot(p[0] - (ax + abx * v + acx * w), p[1] - (ay + aby * v + acy * w), p[2] - (az + abz * v + acz * w));
}
