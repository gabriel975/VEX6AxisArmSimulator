// reach_map.js - Where can the tool reach pointing straight down? Port of reach_map.py.
// The base joint only rotates the arm, so reachability depends on the distance
// from the base axis r, the height z and J1's range. IK is solved along one
// radius (every 2.5 mm, warm-started), cached per (z, tool length) and swept
// around. Computed in small chunks so the page never freezes.
import * as cfg from "./arm_config.js";
import * as kin from "./kinematics.js";

export const R_STEP = 2.5;
export const R_MAX = cfg.SHOULDER_OFFSET + cfg.UPPER_ARM + cfg.FOREARM_REACH + 120.0;
const cache = new Map();

const key = (z, tl) => `${z.toFixed(1)}|${tl.toFixed(1)}`;

/** {radii, ok} for the tool pointing down at height z (async, yields to the page). */
export async function radialProfile(z, toolLength, { chunk = 12 } = {}) {
  const k = key(z, toolLength);
  if (cache.has(k)) return cache.get(k);
  const radii = [], ok = [];
  for (let r = 0; r <= R_MAX + 1e-9; r += R_STEP) radii.push(r);
  let q = null;
  for (let i = 0; i < radii.length; i++) {
    const res = kin.solveIK([radii[i], 0, z], { qInit: q || undefined, toolDir: kin.DOWN, toolLength, maxIters: 80, restarts: 6 });
    ok.push(res.success);
    if (res.success) q = res.q;
    if (chunk && i % chunk === chunk - 1) await new Promise((r) => setTimeout(r, 0));
  }
  const prof = { radii, ok };
  cache.set(k, prof);
  return prof;
}
export function radialProfileSync(z, toolLength) {
  const k = key(z, toolLength);
  if (cache.has(k)) return cache.get(k);
  const radii = [], ok = [];
  for (let r = 0; r <= R_MAX + 1e-9; r += R_STEP) radii.push(r);
  let q = null;
  for (const r of radii) {
    const res = kin.solveIK([r, 0, z], { qInit: q || undefined, toolDir: kin.DOWN, toolLength, maxIters: 80, restarts: 6 });
    ok.push(res.success);
    if (res.success) q = res.q;
  }
  const prof = { radii, ok };
  cache.set(k, prof);
  return prof;
}

export function reachableXY(x, y, prof) {
  const r = Math.hypot(x, y);
  const idx = Math.min(prof.radii.length - 1, Math.max(0, Math.round(r / R_STEP)));
  const yaw = Math.atan2(y, x) * 180 / Math.PI;
  const [lo, hi] = cfg.JOINT_LIMITS[0];
  return prof.ok[idx] && yaw >= lo && yaw <= hi && r <= prof.radii.at(-1);
}

export function grid(bounds, prof, cell = 10) {
  const [x0, x1, y0, y1] = bounds;
  const xs = [], ys = [];
  for (let x = x0 + cell / 2; x < x1; x += cell) xs.push(x);
  for (let y = y0 + cell / 2; y < y1; y += cell) ys.push(y);
  const mask = xs.map((x) => ys.map((y) => reachableXY(x, y, prof)));
  return { xs, ys, mask, cell };
}

export function reachLimits(prof) {
  const r = prof.radii.filter((_, i) => prof.ok[i]);
  return r.length ? [Math.min(...r), Math.max(...r)] : null;
}

export class ReachMap {
  constructor() {
    this.height = 100;
    this.showBand = true;
    this.table = null;
    this.band = null;
    this.version = 0;
    this.busy = false;
    this._key = null;
    this._job = null;
  }
  request(bounds, toolLength, cell = 10) {
    const k = JSON.stringify([bounds.map((v) => +v.toFixed(1)), +toolLength.toFixed(1), this.height, this.showBand, cell]);
    if (k === this._key) return this._job;
    this._key = k;
    this.busy = true;
    this._job = (async () => {
      const t = grid(bounds, await radialProfile(0, toolLength), cell);
      const b = this.showBand ? grid(bounds, await radialProfile(this.height, toolLength), cell) : null;
      if (this._key === k) { this.table = t; this.band = b; this.version++; this.busy = false; }
    })();
    return this._job;
  }
}
