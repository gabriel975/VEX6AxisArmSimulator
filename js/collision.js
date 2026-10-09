// collision.js - Collision warnings: the arm's links are capsules (segment +
// radius), objects are axis-aligned boxes. Port of collision.py.
import * as cfg from "./arm_config.js";
import { sub, add, scale, norm, dot } from "./kinematics.js";

export const LINK_NAMES = { base: "base", turret: "base", upper: "upper arm", elbow: "elbow", forearm: "forearm", wrist: "wrist", tool: "tool" };
export const TOOL_RADIUS = { MAGNET: 9.0, PEN: 7.0, NONE: 0.0 };
export const SELF_PAIRS = [["base", "forearm"], ["base", "wrist"], ["base", "tool"], ["turret", "forearm"], ["turret", "wrist"], ["turret", "tool"],
  ["upper", "wrist"], ["upper", "tool"]];

export function armCapsules(fk, toolType = "MAGNET") {
  const p = fk.points();
  const caps = [
    // the fixed base (flange + body) as a squat capsule, then the rotating turret up to the shoulder
    ["base", [0, 0, -40], [0, 0, cfg.BASE_BODY_HEIGHT - 15], cfg.BASE_BODY_RADIUS],
    ["turret", [0, 0, cfg.BASE_BODY_HEIGHT - 10], [0, 0, Math.max(cfg.BASE_BODY_HEIGHT, p.shoulder[2] - 24)], cfg.TURRET_RADIUS],
    ["upper", p.shoulder, p.elbow, cfg.LINK_RADIUS],
    ["elbow", p.elbow, p.forearm, cfg.JOINT_RADIUS - 2],
    ["forearm", p.forearm, p.wrist, cfg.LINK_RADIUS - 3],
    ["wrist", p.wrist, p.flange, 12.0],
  ];
  const r = TOOL_RADIUS[toolType] ?? 8.0;
  if (r > 0) {
    const d = sub(p.tool, p.flange);
    const n = norm(d);
    if (n > r + 2) caps.push(["tool", p.flange, sub(p.tool, scale(d, (r + 2) / n)), r]);   // ends 2 mm above the tip
  }
  return caps;
}

export function capsuleBoxDistance(p0, p1, lo, hi) {
  const len = norm(sub(p1, p0));
  const n = Math.max(2, Math.floor(len / 4.0) + 1);
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const q = add(scale(p0, 1 - t), scale(p1, t));
    let s = 0;
    for (let k = 0; k < 3; k++) { const d = Math.max(lo[k] - q[k], 0, q[k] - hi[k]); s += d * d; }
    best = Math.min(best, Math.sqrt(s));
  }
  return best;
}

export function segmentDistance(a0, a1, b0, b1) {
  const d1 = sub(a1, a0), d2 = sub(b1, b0), r = sub(a0, b0);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  if (a < 1e-9 && e < 1e-9) return norm(r);
  if (a < 1e-9) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = dot(d1, r);
    if (e < 1e-9) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-9 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  return norm(sub(add(a0, scale(d1, s)), add(b0, scale(d2, t))));
}

/** boxes: [{name, lo, hi}] -> [[link, name], ...] */
export function armObjectHits(fk, toolType, boxes, tol = 1.0) {
  const hits = [];
  const caps = armCapsules(fk, toolType);
  for (const { name, lo, hi } of boxes) {
    const l = lo.map((v) => v + tol), h = hi.map((v) => v - tol);
    if (h.some((v, k) => v < l[k])) continue;
    for (const [link, p0, p1, r] of caps) if (capsuleBoxDistance(p0, p1, l, h) < r) hits.push([link, name]);
  }
  return hits;
}

export function armSelfHits(fk, toolType = "MAGNET", margin = 2.0) {
  const caps = Object.fromEntries(armCapsules(fk, toolType).map(([l, p0, p1, r]) => [l, [p0, p1, r]]));
  const hits = [];
  for (const [a, b] of SELF_PAIRS) {
    if (caps[a] && caps[b]) {
      const [a0, a1, ra] = caps[a], [b0, b1, rb] = caps[b];
      if (segmentDistance(a0, a1, b0, b1) < ra + rb - margin) hits.push([a, b]);
    }
  }
  return hits;
}

export function describe(hits, selfHits) {
  const parts = hits.slice(0, 2).map(([l, n]) => `${LINK_NAMES[l]} hits ${n}`);
  for (const [a, b] of selfHits.slice(0, 1)) parts.push(`${LINK_NAMES[a]} hits ${LINK_NAMES[b]}`);
  return parts.join(", ");
}
