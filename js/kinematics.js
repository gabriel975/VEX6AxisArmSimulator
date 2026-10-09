// kinematics.js - Forward / inverse kinematics and limit checks.
// Line-for-line port of six_axis_arm/kinematics.py (no numpy: tiny 3x3/4x4/6x6 helpers).
// Angles are DEGREES at the API, positions in mm.
import * as cfg from "./arm_config.js";

// (offset applied BEFORE the joint, rotation axis of the joint)
export const CHAIN = [
  [[0, 0, 0], "z"],                   // J1 base yaw
  [[0, 0, cfg.BASE_HEIGHT], "y"],     // J2 shoulder pitch
  [[0, 0, cfg.UPPER_ARM], "y"],       // J3 elbow pitch
  [[cfg.FOREARM, 0, 0], "x"],         // J4 wrist roll
  [[0, 0, 0], "y"],                   // J5 wrist pitch
  [[0, 0, 0], "x"],                   // J6 tool roll
];
export const FLANGE_OFFSET = [cfg.WRIST_TO_FLANGE, 0, 0];
export const AXIS_INDEX = { x: 0, y: 1, z: 2 };
export const N_JOINTS = 6;
export const LIMITS = cfg.JOINT_LIMITS;
const DEG = Math.PI / 180;

// Extra IK starting poses: exactly the ones numpy's default_rng(1234) draws in
// the Python version, so both versions find the same solutions.
const RANDOM_SEEDS = [[162.07792067736835, -21.56476769646879, 57.71939740223286, -71.49227284093675, -43.41670598059258, -137.48715613200858], [-87.79946029405306, -32.66389281919925, 64.25267922854022, -70.90505871747187, -14.158530707157254, 39.5534913921027], [123.63124083378665, 65.47638073942522, 17.98101013595121, 47.962304387829334, 56.58184759582906, -99.80868307270059], [-111.49749721521289, 66.67469504800837, -80.3778147517576, 55.10667272580321, 41.0971245937923, 39.9664731999637], [-149.55331366356208, 85.99846924937509, -19.767739720514882, 9.778506456871156, -119.24825101012095, -89.54384202313047], [121.8867487235924, -13.44629678466282, 27.731039046346737, 126.61296504309172, -83.16619892925226, 177.2133226155429], [-108.00719383135586, 79.22032241089042, -76.09871115629018, -9.536785477844717, 78.95740798293235, -78.8211853322845], [125.49111380205392, 85.75498337293055, 44.674185191450704, -15.337919903086856, -31.07797685503475, -6.239002675014007], [-138.65827407158486, -49.19704109023329, -4.1494021197900395, 69.96949535125165, -12.26141066109075, -70.0197229232957], [152.10226511813823, 45.186090544677, -14.472246420442247, -12.817236121527628, 59.12107277687741, 127.9439560215281], [-70.2094702336887, 41.99660987709191, 39.412912409966594, 116.1260922515209, -114.04002929591331, 4.517801169013637], [38.347131328284206, -39.53718870677393, -17.658923748149974, 9.366326703505536, 117.27229522287871, -177.84785920571477], [-101.56198290406387, -43.76235665855226, -35.48082575098442, -134.09941123635622, -41.64132110863906, -108.59104541409054], [111.93306918723488, 24.681893153561916, -76.32948229396203, -83.95186881378497, 43.482241355159005, -131.61236780569283], [155.21465489513474, -65.42568406707302, 37.63234223588964, -0.5119432439240654, -46.87014542547952, -95.68582120559488], [133.62277651399518, -22.04342928840532, -77.78472774061754, -139.85794366874953, -9.212802664027834, 134.5766258651363], [-50.792773053332326, 58.233699296088986, 61.551851898744275, -129.88778703302458, -48.518378251530436, 42.89796589221106], [-67.40247392913727, -58.527638797486055, -10.719168765176477, 78.17112007981515, 44.94277849727675, -90.66427938875948], [41.49584209130319, -33.18197565966327, -45.6453732466602, 128.95956323858616, -52.897135411547026, 161.58060559425627], [-101.31410055881675, 11.786114639225985, -29.151499131903904, 92.43201817253532, -89.38711969256254, 162.48223848119312]];

// ---------------------------------------------------------- 4x4 helpers ---
// Matrices are row-major arrays of 16 numbers.
export function eye4() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
export function mul4(a, b) {
  const r = new Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    r[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j];
  }
  return r;
}
export function trans(x, y, z) { const t = eye4(); t[3] = x; t[7] = y; t[11] = z; return t; }
export function rot(axis, a) {
  const c = Math.cos(a), s = Math.sin(a), r = eye4();
  if (axis === "x") { r[5] = c; r[6] = -s; r[9] = s; r[10] = c; }
  else if (axis === "y") { r[0] = c; r[2] = s; r[8] = -s; r[10] = c; }
  else { r[0] = c; r[1] = -s; r[4] = s; r[5] = c; }
  return r;
}
export const pos = (m) => [m[3], m[7], m[11]];
export const col = (m, k) => [m[k], m[4 + k], m[8 + k]];           // column k of the 3x3 part
export const rot3 = (m) => [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];

// --------------------------------------------------------- vector helpers ---
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const matmul3 = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const transpose3 = (a) => [0, 1, 2].map((i) => [a[0][i], a[1][i], a[2][i]]);

export const R_DOWN = rot3(rot("y", Math.PI / 2));     // tool axis +X -> world -Z
export const DOWN = [0, 0, -1];

export function yprToMatrix(yaw, roll, pitch) {
  const r = rot3(mul4(mul4(rot("z", yaw * DEG), rot("y", pitch * DEG)), rot("x", roll * DEG)));
  return matmul3(r, R_DOWN);
}
export function matrixToYpr(rTool) {
  const r = matmul3(rTool, transpose3(R_DOWN));
  const pitch = Math.asin(Math.max(-1, Math.min(1, -r[2][0])));
  const yaw = Math.atan2(r[1][0], r[0][0]);
  const roll = Math.atan2(r[2][1], r[2][2]);
  return [yaw / DEG, roll / DEG, pitch / DEG];
}

// --------------------------------------------------------------- forward ---
export class FKResult {
  constructor(frames, flange, tcp) { this.jointFrames = frames; this.flange = flange; this.tcp = tcp; }
  get position() { return pos(this.tcp); }
  get rotation() { return rot3(this.tcp); }
  points() {
    const f = this.jointFrames;
    return { base: pos(f[0]), shoulder: pos(f[1]), elbow: pos(f[2]), wrist: pos(f[3]),
             flange: pos(this.flange), tool: pos(this.tcp) };
  }
}

export function forwardKinematics(q, toolLength = cfg.TOOL_LENGTH.MAGNET) {
  let t = eye4();
  const frames = [];
  for (let i = 0; i < 6; i++) {
    const [off, axis] = CHAIN[i];
    t = mul4(mul4(t, trans(off[0], off[1], off[2])), rot(axis, q[i] * DEG));
    frames.push(t);
  }
  const flange = mul4(t, trans(...FLANGE_OFFSET));
  const tcp = mul4(flange, trans(toolLength, 0, 0));
  return new FKResult(frames, flange, tcp);
}

/** Geometric Jacobian, 6 rows x 6 columns (rows 0-2 linear mm/rad, 3-5 angular). */
export function jacobian(fk) {
  const pEnd = pos(fk.tcp);
  const j = [[], [], [], [], [], []];
  for (let i = 0; i < 6; i++) {
    const frame = fk.jointFrames[i];
    const z = col(frame, AXIS_INDEX[CHAIN[i][1]]);
    const lin = cross(z, sub(pEnd, pos(frame)));
    for (let k = 0; k < 3; k++) { j[k][i] = lin[k]; j[3 + k][i] = z[k]; }
  }
  return j;
}

// ---------------------------------------------------------------- limits ---
export const clampToLimits = (q) => q.map((v, i) => Math.min(LIMITS[i][1], Math.max(LIMITS[i][0], v)));
export const withinLimits = (q, tol = 1e-6) => q.every((v, i) => v >= LIMITS[i][0] - tol && v <= LIMITS[i][1] + tol);
export const jointsAtLimit = (q, tol = 0.5) => q.map((v, i) => v <= LIMITS[i][0] + tol || v >= LIMITS[i][1] - tol);

export function floorViolations(q, toolLength = cfg.TOOL_LENGTH.MAGNET) {
  const pts = forwardKinematics(q, toolLength).points();
  return Object.keys(pts).filter((k) => pts[k][2] < cfg.FLOOR_Z - cfg.FLOOR_MARGIN);
}
export function selfCollision(q, toolLength = cfg.TOOL_LENGTH.MAGNET) {
  const [radius, height] = cfg.BASE_KEEPOUT;
  const pts = forwardKinematics(q, toolLength).points();
  return ["wrist", "flange", "tool"].filter((n) => Math.hypot(pts[n][0], pts[n][1]) < radius && pts[n][2] < height);
}
export function poseProblems(q, toolLength = cfg.TOOL_LENGTH.MAGNET) {
  const out = [];
  if (!withinLimits(q)) out.push("joint limit exceeded");
  const fl = floorViolations(q, toolLength);
  if (fl.length) out.push("below floor: " + fl.join(", "));
  const sc = selfCollision(q, toolLength);
  if (sc.length) out.push("hits base: " + sc.join(", "));
  return out;
}

// --------------------------------------------------------------- inverse ---
/** Solve A x = b (A n x n) with partial pivoting. */
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (p !== c) { const t = M[p]; M[p] = M[c]; M[c] = t; }
    const piv = M[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / piv;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

function rotationError(rTarget, rCur) {
  let e = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    e = add(e, cross([rCur[0][k], rCur[1][k], rCur[2][k]], [rTarget[0][k], rTarget[1][k], rTarget[2][k]]));
  }
  return scale(e, 0.5);
}

function solveOnce(target, q0, rTarget, toolDir, toolLength, maxIters, posTol, rotTol,
                   wRot = 120.0, damping = 8.0, maxStepDeg = 12.0) {
  let q = clampToLimits(q0);
  let posErr = Infinity, rotErr = Infinity;
  for (let it = 1; it <= maxIters; it++) {
    const fk = forwardKinematics(q, toolLength);
    const ePos = sub(target, pos(fk.tcp));
    posErr = norm(ePos);
    const jac = jacobian(fk);
    let err, jj;
    if (rTarget) {
      const eRot = rotationError(rTarget, rot3(fk.tcp));
      rotErr = norm(eRot);
      err = [...ePos, ...scale(eRot, wRot)];
      jj = [jac[0], jac[1], jac[2], ...jac.slice(3).map((r) => r.map((v) => v * wRot))];
    } else if (toolDir) {
      const a = col(fk.tcp, 0);
      const eRot = cross(a, toolDir);
      rotErr = Math.acos(Math.max(-1, Math.min(1, dot(a, toolDir))));
      // proj = I - a a^T applied to the angular rows
      const ang = jac.slice(3);
      const projected = [0, 1, 2].map((r) => ang[0].map((_, c) =>
        wRot * ((r === 0 ? 1 : 0) - a[r] * a[0]) * ang[0][c] +
        wRot * ((r === 1 ? 1 : 0) - a[r] * a[1]) * ang[1][c] +
        wRot * ((r === 2 ? 1 : 0) - a[r] * a[2]) * ang[2][c]));
      err = [...ePos, ...scale(eRot, wRot)];
      jj = [jac[0], jac[1], jac[2], ...projected];
    } else {
      rotErr = 0;
      err = ePos;
      jj = [jac[0], jac[1], jac[2]];
    }
    if (posErr < posTol && rotErr < rotTol) return { q, posErr, rotErr, it, ok: true };
    // damped least squares: dq = J^T (J J^T + lambda^2 I)^-1 e
    const m = jj.length;
    const jjt = [];
    for (let r = 0; r < m; r++) {
      jjt.push([]);
      for (let c = 0; c < m; c++) {
        let s = 0;
        for (let k = 0; k < 6; k++) s += jj[r][k] * jj[c][k];
        jjt[r].push(s + (r === c ? damping * damping : 0));
      }
    }
    const y = solve(jjt, err);
    const dq = [0, 0, 0, 0, 0, 0];
    for (let k = 0; k < 6; k++) { let s = 0; for (let r = 0; r < m; r++) s += jj[r][k] * y[r]; dq[k] = s / DEG; }
    const biggest = Math.max(...dq.map(Math.abs));
    if (biggest > maxStepDeg) for (let k = 0; k < 6; k++) dq[k] *= maxStepDeg / biggest;
    const qNew = clampToLimits(q.map((v, k) => v + dq[k]));
    if (Math.max(...qNew.map((v, k) => Math.abs(v - q[k]))) < 1e-7) break;   // stuck against limits
    q = qNew;
  }
  return { q, posErr, rotErr, it: maxIters, ok: false };
}

/**
 * Numerical IK (damped least squares) with joint limits.
 * opts: {qInit, targetRot (3x3), toolDir ([x,y,z]), toolLength, maxIters, posTol, rotTol, restarts, checkPose}
 * Returns {success, q, positionError, orientationError, iterations, reason, problems}.
 */
export function solveIK(targetXyz, opts = {}) {
  const { targetRot = null, toolLength = cfg.TOOL_LENGTH.MAGNET, maxIters = 150, posTol = 0.02,
          rotTol = 0.005, restarts = 12, checkPose = true } = opts;
  let toolDir = opts.toolDir || null;
  const qInit = opts.qInit || [0, 0, 0, 0, 0, 0];
  const target = [...targetXyz].map(Number);
  if (toolDir) { const n = norm(toolDir); toolDir = scale(toolDir, 1 / n); }
  const shoulder = [0, 0, cfg.BASE_HEIGHT];
  const reach = cfg.UPPER_ARM + cfg.FOREARM + cfg.WRIST_TO_FLANGE + toolLength;
  const fail = (reason) => ({ success: false, q: clampToLimits(qInit), positionError: Infinity,
                              orientationError: 0, iterations: 0, reason, problems: [] });
  if (norm(sub(target, shoulder)) > reach + posTol) return fail("out of reach (too far)");
  if (target[2] < cfg.FLOOR_Z - posTol) return fail("target is below the floor");

  const yaw = Math.hypot(target[0], target[1]) > 1 ? Math.atan2(target[1], target[0]) / DEG : 0;
  const seeds = [[...qInit]];
  for (const s of [[0, 30, 30, 0, 60, 0], [0, -20, 60, 0, 50, 0], [0, 45, -20, 0, 90, 0],
                   [0, 10, 10, 0, 70, 0], [0, 60, 20, 0, 0, 0], [0, -45, 30, 0, 30, 0]]) {
    seeds.push([yaw, ...s.slice(1)]);
  }
  const nFixed = seeds.length;                     // 7, like the Python version
  for (let i = 0; i < restarts - nFixed && i < RANDOM_SEEDS.length; i++) seeds.push([...RANDOM_SEEDS[i]]);
  let best = null;
  for (const seed of seeds) {
    const r = solveOnce(target, seed, targetRot, toolDir, toolLength, maxIters, posTol, rotTol);
    const problems = checkPose ? poseProblems(r.q, toolLength) : [];
    if (r.ok && problems.length === 0) {
      return { success: true, q: r.q, positionError: r.posErr, orientationError: r.rotErr,
               iterations: r.it, reason: "ok", problems: [] };
    }
    const score = r.posErr + 100 * r.rotErr + (problems.length ? 1000 : 0);
    if (!best || score < best.score) {
      best = { score, res: { success: false, q: r.q, positionError: r.posErr, orientationError: r.rotErr,
                             iterations: r.it, reason: "", problems } };
    }
  }
  const res = best.res;
  if (res.problems.length && res.positionError < posTol) res.reason = "only reachable by breaking a rule: " + res.problems.join("; ");
  else if (res.positionError < posTol) res.reason = "position reachable but not with that tool orientation";
  else res.reason = `out of reach (closest ${res.positionError.toFixed(0)} mm away)`;
  return res;
}

/** Joint keyframes moving the tool in a straight line, or null. */
export function planLinear(qStart, targetXyz, targetRot = null, toolDir = null,
                           toolLength = cfg.TOOL_LENGTH.MAGNET, stepMm = 5.0, maxJointJump = 20.0) {
  const p0 = forwardKinematics(qStart, toolLength).position;
  const p1 = [...targetXyz].map(Number);
  const n = Math.max(1, Math.ceil(norm(sub(p1, p0)) / stepMm));
  const path = [[...qStart]];
  let q = [...qStart];
  for (let k = 1; k <= n; k++) {
    const p = add(p0, scale(sub(p1, p0), k / n));
    const res = solveIK(p, { qInit: q, targetRot, toolDir, toolLength, maxIters: 60, restarts: 1 });
    if (!res.success || Math.max(...res.q.map((v, i) => Math.abs(v - q[i]))) > maxJointJump) return null;
    q = res.q;
    path.push(q);
  }
  return path;
}
