// arm_core.js - The simulated arm "brain": joint angles, smooth motion, the move
// queue, the magnet and the objects on the platform. Port of arm_core.py.
// No graphics; step(dt) is called every animation frame.
import * as cfg from "./arm_config.js";
import * as kin from "./kinematics.js";
import * as bodies from "./bodies.js";

export const MAGNET_RANGE_CUBE = 18.0;   // mm from the tip to the top centre of a cube / disk
export const MAGNET_RANGE_MESH = 6.0;    // mm from the tip to the surface of an imported model

export const smoothstep = (s) => { s = Math.min(1, Math.max(0, s)); return s * s * (3 - 2 * s); };

export class Trajectory {
  constructor(keyframes, duration, label = "") {
    this.keys = keyframes.map((k) => [...k]);
    this.duration = Math.max(1e-3, duration);
    this.t = 0;
    this.label = label;
  }
  sample() {
    if (this.keys.length === 1) return [...this.keys[0]];
    const s = smoothstep(this.t / this.duration) * (this.keys.length - 1);
    const i = Math.min(Math.floor(s), this.keys.length - 2);
    const f = s - i;
    return this.keys[i].map((v, k) => v * (1 - f) + this.keys[i + 1][k] * f);
  }
  step(dt) { this.t = Math.min(this.duration, this.t + dt); return this.sample(); }
  get done() { return this.t >= this.duration; }
}

let objectIds = 0;
export class SceneObject {
  constructor(name, kind, pos, { size = 25, height = 25, color = [0.9, 0.2, 0.2] } = {}) {
    this.id = ++objectIds;
    this.name = name;
    this.kind = kind;            // "cube" | "disk"
    this.pos = [...pos];         // centre of the bottom face, mm
    this.size = size;            // cube edge / disk diameter
    this.height = height;
    this.rot = [0, 0, 0];        // rotation: Euler degrees about X, Y, Z (see bodies.js)
    this.color = [...color];
    this.held = false;
  }
  top() { return this.pos[2] + this.height; }
}

export class Platform {
  constructor(width = cfg.PLATFORM_SIZE[0], depth = cfg.PLATFORM_SIZE[1]) { this.resize(width, depth); }
  resize(width, depth) {
    const lo = cfg.PLATFORM_MIN, hi = cfg.PLATFORM_MAX;
    this.width = Math.min(hi, Math.max(lo, Math.round(Number(width) || 0)));
    this.depth = Math.min(hi, Math.max(lo, Math.round(Number(depth) || 0)));
    return this;
  }
  get size() { return [this.width, this.depth]; }
  /** The arm sits near the back-right corner like on the real Tile: the base centre
   *  keeps its distance from the back (-X) and right-hand (-Y) edges, so a bigger
   *  platform grows to the front and to the arm's left. */
  get center() {
    const back = Math.min(cfg.PLATFORM_BACK_MARGIN, this.width / 2), side = Math.min(cfg.PLATFORM_SIDE_MARGIN, this.depth / 2);
    return [this.width / 2 - back, this.depth / 2 - side];
  }
  bounds() { const [cx, cy] = this.center; return [cx - this.width / 2, cx + this.width / 2, cy - this.depth / 2, cy + this.depth / 2]; }
  contains(x, y, hx = 0, hy = 0, tol = 0.5) {
    const [x0, x1, y0, y1] = this.bounds();
    return x - hx >= x0 - tol && x + hx <= x1 + tol && y - hy >= y0 - tol && y + hy <= y1 + tol;
  }
  clamp(x, y, hx = 0, hy = 0) {
    const [x0, x1, y0, y1] = this.bounds();
    if (2 * hx > x1 - x0 || 2 * hy > y1 - y0) return null;
    return [Math.min(x1 - hx, Math.max(x0 + hx, x)), Math.min(y1 - hy, Math.max(y0 + hy, y))];
  }
}

export class ArmController {
  constructor() {
    this.q = [0, 0, 0, 0, 0, 0];
    this.toolType = "MAGNET";
    this.penOffset = cfg.DEFAULT_PEN_OFFSET;
    this.speedPercent = cfg.DEFAULT_SPEED_PERCENT;
    this.magnetOn = false;
    this.queue = [];
    this.current = null;
    this.objects = [];
    this.platform = new Platform();
    this.target = null;
    this.targetReachable = true;
    this.message = "";
    this.controlStopped = false;
    this.events = [];
    this.held = null;                 // {body, localOffset, relYaw} while the magnet carries something
    this.getModels = () => [];        // the app plugs in its imported models here
    this.goHome(true);
  }
  /** Everything on the Tile: cubes / disks and imported models. */
  bodies() { return [...this.objects, ...this.getModels()]; }

  get toolLength() { return (cfg.TOOL_LENGTH[this.toolType] || 0) + (this.toolType === "PEN" ? this.penOffset : 0); }
  fk(q = null) { return kin.forwardKinematics(q || this.q, this.toolLength); }
  position() { return this.fk().position; }
  orientation() { return kin.matrixToYpr(this.fk().rotation); }
  isDone() { return this.current === null && this.queue.length === 0; }
  say(msg) { this.message = msg; this.events.push(msg); if (this.events.length > 200) this.events.shift(); }
  stop() { this.queue = []; this.current = null; }

  // ------------------------------------------------------ joint control ---
  setJoint(i, angle) {
    this.stop();
    const [lo, hi] = kin.LIMITS[i];
    const q = [...this.q];
    q[i] = Math.min(hi, Math.max(lo, angle));
    const problems = kin.poseProblems(q, this.toolLength);
    if (problems.length) { this.say(`Blocked: ${problems[0]}`); return false; }
    if (q[i] !== angle) this.say(`${cfg.JOINT_NAMES[i]} is at its limit (${q[i].toFixed(0)} deg)`);
    this.q = q;
    this.updateHeld();
    return true;
  }
  jogJoint(i, delta) { return this.setJoint(i, this.q[i] + delta); }
  setJoints(q, check = true) {
    q = kin.clampToLimits(q);
    if (check && kin.poseProblems(q, this.toolLength).length) return false;
    this.q = q;
    this.updateHeld();
    return true;
  }

  // ------------------------------------------------------------ motion ---
  jointDuration(q0, q1) {
    const frac = Math.max(1, this.speedPercent) / 100;
    const times = q0.map((a, i) => Math.abs(q1[i] - a) / (cfg.MAX_JOINT_SPEED[i] * frac));
    return Math.max(0.15, Math.max(...times) * 1.5);
  }
  endQ() {
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i] instanceof Trajectory) return this.queue[i].keys.at(-1);
    if (this.current) return this.current.keys.at(-1);
    return this.q;
  }
  queueJointMove(qTarget, label = "") {
    const q0 = [...this.endQ()];
    const q1 = kin.clampToLimits(qTarget);
    this.queue.push(new Trajectory([q0, q1], this.jointDuration(q0, q1), label));
  }
  planMoveTo(xyz, { ypr = null, keepOrientation = true, toolDown = false, linear = true } = {}) {
    const q0 = [...this.endQ()];
    const fk0 = this.fk(q0);
    let rTarget = null, toolDir = null;
    if (ypr) rTarget = kin.yprToMatrix(...ypr);
    else if (toolDown) toolDir = kin.DOWN;
    else if (keepOrientation) rTarget = fk0.rotation;
    const res = kin.solveIK(xyz, { qInit: q0, targetRot: rTarget, toolDir, toolLength: this.toolLength });
    if (!res.success) return [null, res];
    let keys = linear ? kin.planLinear(q0, xyz, rTarget, toolDir, this.toolLength) : null;
    if (!keys) keys = [q0, res.q];
    return [keys, res];
  }
  moveTo(xyz, { ypr = null, keepOrientation = true, toolDown = false, linear = true, label = "move_to" } = {}) {
    if (this.controlStopped) { this.say("Control stop is on - not moving"); return false; }
    this.target = [...xyz];
    const [keys, res] = this.planMoveTo(xyz, { ypr, keepOrientation, toolDown, linear });
    this.targetReachable = keys !== null;
    const f = (v) => v.toFixed(0);
    if (!keys) { this.say(`Unreachable (${f(xyz[0])}, ${f(xyz[1])}, ${f(xyz[2])}): ${res.reason}`); return false; }
    const p0 = this.fk(keys[0]).position;
    const dist = kin.norm(kin.sub(xyz, p0));
    const frac = Math.max(1, this.speedPercent) / 100;
    const tLin = dist / (cfg.MAX_LINEAR_SPEED * frac) * 1.5;
    const duration = Math.max(tLin, this.jointDuration(keys[0], keys.at(-1)), 0.15);
    this.queue.push(new Trajectory(keys, duration, label));
    this.say(`Moving to (${f(xyz[0])}, ${f(xyz[1])}, ${f(xyz[2])})`);
    return true;
  }
  canReach(xyz, ypr = null, keepOrientation = true) {
    return this.planMoveTo(xyz, { ypr, keepOrientation, linear: false })[0] !== null;
  }
  homeJoints() {
    return kin.solveIK(cfg.SAFE_POSITION, { qInit: [0, 0, 30, 0, 60, 0], targetRot: kin.yprToMatrix(0, 0, 0),
                                           toolLength: this.toolLength }).q;
  }
  goHome(instant = false) {
    const q = this.homeJoints();
    if (instant) { this.stop(); this.q = q; } else this.queueJointMove(q, "home");
    this.target = null;
  }
  queueCall(fn) { this.queue.push(fn); }
  step(dt) {
    for (;;) {
      if (this.current === null) {
        if (!this.queue.length) return;
        const item = this.queue.shift();
        if (typeof item === "function") { item(); continue; }
        this.current = item;
      }
      this.q = this.current.step(dt);
      this.updateHeld();
      if (this.current.done) {
        this.current = null;
        dt = 0;
        if (!this.queue.length && this.message.startsWith("Moving to")) {
          const p = this.position().map((v) => Math.round(v));
          this.say(`Reached (${p[0]}, ${p[1]}, ${p[2]})`);
        }
        continue;
      }
      return;
    }
  }
  runUntilDone(dt = 1 / 60, maxTime = 120) {
    let t = 0;
    while (!this.isDone() && t < maxTime) { this.step(dt); t += dt; }
    return t;
  }

  // ------------------------------------------------------------ magnet ---
  /** Rotation of the tool about the vertical axis (its local y axis seen from above), degrees. */
  toolYaw(fk = this.fk()) { const r = fk.rotation; return Math.atan2(r[1][1], r[0][1]) * 180 / Math.PI; }
  /** The body the magnet would grab right now, or null: a cube / disk whose top centre is
   *  within 18 mm of the tip, or a magnetic model whose surface is within 6 mm of the tip
   *  (and the tip is not below that surface). */
  magnetCandidate(tip = this.position()) {
    let best = null, bestScore = Infinity;
    for (const b of this.bodies()) {
      if (b.held) continue;
      let score;
      if (bodies.isModel(b)) {
        if (!b.magnetic) continue;
        const d = bodies.pointDistance(b, tip, MAGNET_RANGE_MESH);
        if (d >= MAGNET_RANGE_MESH) continue;                 // the query returns the cut-off when nothing is nearer
        const top = bodies.topUnder(b, tip);
        if (top === null && bodies.intervals(b, tip[0], tip[1]).length) continue;   // tip is deep inside / under it
        score = d / MAGNET_RANGE_MESH;
      } else {
        // the top centre of the (possibly rotated) cube / disk: its local top-face centre in the world
        const topCentre = bodies.localToWorld(b, [0, 0, b.height]);
        const d = kin.norm(kin.sub(topCentre, tip));
        if (d >= MAGNET_RANGE_CUBE) continue;
        score = d / MAGNET_RANGE_CUBE;
      }
      if (score < bestScore) { best = b; bestScore = score; }
    }
    return best;
  }
  setMagnet(on) {
    this.magnetOn = !!on;
    if (on) {
      if (this.held) return;
      const fk = this.fk(), tip = fk.position;
      const best = this.magnetCandidate(tip);
      if (best) {
        // rigid attachment: remember the body's pose in the tool frame
        const Rt = bodies.transpose3(fk.rotation);
        this.held = { body: best, localOffset: bodies.apply3(Rt, kin.sub(bodies.origin(best), tip)), relR: bodies.mul3(Rt, bodies.rotationMatrix(best)) };
        best.held = true;
        this.say(`Picked up ${best.name}`);
      }
    } else this.releaseHeld();
  }
  /** Let go of what the magnet carries: it falls onto whatever is below it. */
  releaseHeld() {
    const h = this.held;
    if (!h) return null;
    this.held = null;
    const b = h.body;
    b.held = false;
    if (bodies.bottomZ(b) < 0) bodies.setBottomZ(b, 0);
    const z = bodies.dropZ(b, this.bodies(), { fromAbove: false });
    bodies.origin(b)[2] = z;
    bodies.invalidateSamples(b);
    this.say(this.onPlatform(b) ? `Dropped ${b.name}` : `Dropped ${b.name} off the platform`);
    return b;
  }
  updateHeld() {
    const h = this.held;
    if (!h) return;
    const fk = this.fk(), tip = fk.position, R = fk.rotation;
    const d = bodies.apply3(R, h.localOffset);
    bodies.setOrigin(h.body, [tip[0] + d[0], tip[1] + d[1], tip[2] + d[2]]);
    h.body.rot = bodies.eulerFromMatrix(bodies.mul3(R, h.relR));
    bodies.invalidateSamples(h.body);
  }
  addDefaultObjects() {
    // on Tile locations 27, 29 and 18 (the STEM Labs use these for the cube / disk activities)
    this.objects = [
      new SceneObject("Red cube", "cube", [150, 50, 0], { color: [0.85, 0.15, 0.15] }),
      new SceneObject("Blue cube", "cube", [150, 150, 0], { color: [0.15, 0.35, 0.9] }),
      new SceneObject("Green disk", "disk", [50, 200, 0], { size: 30, height: 8, color: [0.1, 0.7, 0.3] }),
    ];
    this.fitObjectsToPlatform();
  }

  // ----------------------------------------------------------- objects ---
  onPlatform(b) { const [hx, hy] = bodies.halfSize(b), o = bodies.origin(b); return this.platform.contains(o[0], o[1], hx, hy); }
  fitObjectsToPlatform() {
    const moved = [], stuck = [];
    for (const ob of this.objects) {
      if (ob.held || this.onPlatform(ob)) continue;
      const spot = this.platform.clamp(ob.pos[0], ob.pos[1], ob.size / 2, ob.size / 2);
      if (!spot) { stuck.push(ob); continue; }
      ob.pos = [spot[0], spot[1], 0];
      moved.push(ob);
    }
    return [moved, stuck];
  }
  setPlatform(width, depth) { this.platform.resize(width, depth); return this.fitObjectsToPlatform(); }
  removeObject(ob) {
    const i = this.objects.indexOf(ob);
    if (i < 0) return false;
    if (ob.held) { ob.held = false; this.held = null; this.magnetOn = false; }
    this.objects.splice(i, 1);
    this.say(`Removed ${ob.name}`);
    return true;
  }
  clearObjects() {
    if (this.objects.some((o) => o.held)) { this.held = null; this.magnetOn = false; }
    this.objects = [];
    this.say("All objects removed");
  }
}
