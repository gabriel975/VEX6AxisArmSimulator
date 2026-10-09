// program_host.js - main-thread side of running a student's Python program.
//
// The Python (Pyodide) runs in a Web Worker (py_worker.js). Every Arm call in
// the program becomes a message here; we act on the simulated arm and reply
// (for a move with wait=True only once the arm has finished, in simulation time).
// Port of the Arm semantics of six_axis_arm/vex.py (v4).
import * as cfg from "./arm_config.js";
import * as kin from "./kinematics.js";
import { PYODIDE_URL, HARD_STOP_MS } from "../settings.js";

const VERSION = "5";
export const SIM_SPEEDS = [0.5, 1, 2, 5, 10];
export const TOWER_COLORS = ["RED", "YELLOW", "GREEN", "BLUE", "WHITE"];
const TILE_CLAMP_MM = 15;

// ------------------------------------------------------------ brain screen ---
export class ScreenLog {
  constructor() { this.notes = []; this.clear(); this.version = 0; }
  clear() { this.rows = [""]; this.row = 0; this.col = 0; this.version = (this.version || 0) + 1; }
  _ensure(r) { while (this.rows.length <= r) this.rows.push(""); }
  write(text) {
    for (const ch of String(text)) {
      if (ch === "\n") { this.newline(); continue; }
      this._ensure(this.row);
      let line = this.rows[this.row];
      if (line.length < this.col) line += " ".repeat(this.col - line.length);
      this.rows[this.row] = line.slice(0, this.col) + ch + line.slice(this.col + 1);
      this.col += 1;
    }
    this.version++;
  }
  newline() {
    this._ensure(this.row);
    this.row += 1; this.col = 0;
    this._ensure(this.row);
    if (this.rows.length > 300) { const cut = this.rows.length - 300; this.rows = this.rows.slice(cut); this.row -= cut; }
    this.version++;
  }
  setCursor(row, col) { this.row = Math.max(0, (row | 0) - 1); this.col = Math.max(0, (col | 0) - 1); this._ensure(this.row); }
  clearRow(row) { const r = row == null ? this.row : Math.max(0, (row | 0) - 1); this._ensure(r); this.rows[r] = ""; this.version++; }
  visible(n = 200) {
    let last = this.row;
    this.rows.forEach((r, i) => { if (r) last = Math.max(last, i); });
    return this.rows.slice(Math.max(0, last - n + 1), last + 1);
  }
  note(msg) {
    if (this.notes.length && this.notes.at(-1) === msg) return;
    this.notes.push(msg);
    if (this.notes.length > 50) this.notes.shift();
    this.version++;
  }
}

const fmt = (v) => (Number.isInteger(v) ? String(v) : (+v.toFixed(2)).toString());
const unitK = (u) => (String(u).toUpperCase() === "INCHES" ? 25.4 : 1);

// ------------------------------------------------------------ program host ---
export class ProgramHost {
  /** app: needs .c (ArmController) and optional hooks onChange(), toast(msg, bad). */
  constructor(app) {
    this.app = app;
    this.worker = null;
    this.pyStatus = "off";          // off | loading | ready | error
    this.pyMessage = "";
    this.state = "idle";            // idle | starting | running | finished | stopped | error
    this.running = false;
    this.paused = false;
    this.pausedAt = "";
    this.currentLine = null;
    this.error = null;
    this.errorLine = null;
    this.status = "";
    this.timeScale = 1;
    this.screen = new ScreenLog();
    this.tower = Object.fromEntries(TOWER_COLORS.map((k) => [k, "OFF"]));
    this.sourceLines = [];
    this.projectName = null;
    this.moveLog = [];
    this.waiters = [];
    this._ready = null;
    this._stopTimer = null;
    this.listeners = new Set();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind, data) { for (const fn of this.listeners) { try { fn(kind, data); } catch (e) { console.error(e); } } }

  // ---- worker
  ensureWorker() {
    if (this._ready) return this._ready;
    this.pyStatus = "loading";
    this.pyMessage = "Loading Python…";
    this.emit("python", this.pyStatus);
    const url = new URL(PYODIDE_URL, document.baseURI).href;
    const pythonBase = new URL("python/", document.baseURI).href;
    this.worker = new Worker(new URL("./py_worker.js", import.meta.url));
    this._ready = new Promise((resolve, reject) => {
      this._readyResolve = resolve; this._readyReject = reject;
    });
    this._ready.catch(() => {});
    this.worker.onmessage = (ev) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => {
      ev.preventDefault?.();
      this.loadFailed(ev.message || "the Python worker could not start");
    };
    this.worker.postMessage({ type: "init", pyodideUrl: url, pythonBase, version: VERSION });
    return this._ready;
  }

  loadFailed(message) {
    this.pyStatus = "error";
    this.pyMessage = message;
    if (this._readyReject) this._readyReject(new Error(message));
    this._ready = null;
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    this.emit("python", this.pyStatus);
  }

  killWorker() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this._ready = null;
    this.pyStatus = "off";
    this.emit("python", this.pyStatus);
  }

  send(msg) { if (this.worker && this.pyStatus === "ready") this.worker.postMessage(msg); }

  // ---- program control
  async run(source, name = "project", { startPaused = false } = {}) {
    if (this.running) return false;
    this.runCount = (this.runCount || 0) + 1;
    this.state = "starting";
    this.projectName = name;
    this.sourceLines = source.split("\n");
    this.error = this.errorLine = null;
    this.status = "Starting Python…";
    this.beginProgram(startPaused);
    this.emit("state", this.state);
    try {
      await this.ensureWorker();
    } catch (e) {
      this.running = false;
      this.state = "error";
      this.tower.GREEN = "OFF";                          // the program never started
      this.status = "Python could not load: " + e.message;
      this.emit("state", this.state);
      return false;
    }
    if (this.state !== "starting") return false;          // stopped while loading
    this.worker.postMessage({ type: "speed", scale: this.timeScale });
    this.worker.postMessage({ type: "run", source, name, startPaused });
    return true;
  }

  beginProgram(startPaused) {
    // VEX resets these when a project starts (v4 vex._Runtime.begin_program)
    const c = this.app.c;
    c.stop();
    c.controlStopped = false;
    c.speedPercent = 50;
    if (c.magnetOn) c.setMagnet(false);
    c.toolType = "MAGNET";
    c.penOffset = 0;
    c.target = null;
    this.running = true;
    this.paused = !!startPaused;
    this.pausedAt = startPaused ? "line" : "";
    this.currentLine = null;
    this.screen = new ScreenLog();
    this.tower = Object.fromEntries(TOWER_COLORS.map((k) => [k, "OFF"]));
    this.tower.GREEN = "ON";
    this.moveLog = [];
    this.waiters = [];
  }

  stop() {
    if (!this.running) return;
    this.app.c.stop();
    if (this.state === "starting" && this.pyStatus !== "ready") { this.finish("stopped"); return; }
    this.send({ type: "stop" });
    for (const w of this.waiters.splice(0)) this.reply(w.id, false);
    clearTimeout(this._stopTimer);
    this._stopTimer = setTimeout(() => {          // program ignored Stop (e.g. a bare except: in a loop)
      if (!this.running) return;
      this.killWorker();
      this.finish("stopped");
      this.status = "Stopped (Python was restarted)";
      this.emit("state", this.state);
      this.ensureWorker().catch(() => {});
    }, HARD_STOP_MS);
  }

  pause() { if (this.running && !this.paused) { this.paused = true; this.pausedAt = "user"; this.send({ type: "pause" }); this.emit("paused", true); } }
  resume() { if (this.running && this.paused) { this.paused = false; this.pausedAt = ""; this.send({ type: "resume" }); this.emit("paused", false); } }
  step(kind = "line") { if (this.running) { this.send({ type: "step", kind }); } }
  setSpeed(scale) { this.timeScale = scale; this.send({ type: "speed", scale }); this.emit("speed", scale); }
  pressTower() {
    if (!this.running) return false;
    this.send({ type: "tower_press" });
    return true;
  }

  finish(state, error = null, line = null) {
    clearTimeout(this._stopTimer);
    this.running = false;
    this.paused = false;
    this.pausedAt = "";
    this.currentLine = null;
    this.waiters = [];
    this.state = state;
    if (error) { this.error = error; this.errorLine = line; this.status = error; }
    else this.status = { finished: "Finished", stopped: "Stopped" }[state] || state;
    if (state !== "error" && this.tower.GREEN === "ON" && !this.app.c.controlStopped) this.tower.GREEN = "OFF";
    this.emit("state", state);
  }

  // ---- per frame: moves that the program is waiting for
  update(simDt) {
    if (!this.waiters.length) return;
    const c = this.app.c;
    const keep = [];
    for (const w of this.waiters) {
      if (c.isDone()) this.reply(w.id, true);
      else if ((w.t += simDt) > w.limit) this.reply(w.id, false);
      else keep.push(w);
    }
    this.waiters = keep;
  }

  reply(id, result) { if (this.worker) this.worker.postMessage({ type: "reply", id, result }); }

  // ---- messages from the worker
  onMessage(m) {
    switch (m.type) {
      case "loading": this.pyMessage = m.message; this.status = m.message; this.emit("python", "loading"); break;
      case "ready":
        this.pyStatus = "ready"; this.pyMessage = `Python ${m.version} ready`;
        this._readyResolve?.(); this.emit("python", "ready"); break;
      case "load_error": this.loadFailed(m.message); break;
      case "started":
        this.state = "running"; this.status = "Running";
        this.paused = !!m.paused; this.emit("state", this.state); break;
      case "line": this.currentLine = m.line; this.emit("line", m.line); break;
      case "paused":
        this.paused = !!m.paused; this.pausedAt = m.why || ""; if (m.line) this.currentLine = m.line;
        this.emit("paused", this.paused); break;
      case "screen": {
        const s = this.screen, a = m.args || [];
        if (m.op === "clear") s.clear();
        else if (m.op === "write") s.write(a[0]);
        else if (m.op === "newline") s.newline();
        else if (m.op === "set_cursor") s.setCursor(a[0], a[1]);
        else if (m.op === "clear_row") s.clearRow(a[0]);
        this.emit("screen"); break;
      }
      case "note": this.screen.note(m.message); this.emit("screen"); break;
      case "tower":
        for (const k of m.colors) {
          if (k === "ALL") for (const kk of TOWER_COLORS) this.tower[kk] = m.state;
          else if (k in this.tower) this.tower[k] = m.state;
        }
        this.emit("tower"); break;
      case "tower_unhandled":
        this.screen.note("Signal Tower button pressed -> controlled stop");
        this.controlStop(); break;
      case "error":
        this.error = m.message; this.errorLine = m.line;
        this.screen.note("ERROR " + m.message);
        this.app.c.stop();
        this.emit("screen"); break;
      case "done":
        this.finish(m.state, m.error, m.line); break;
      case "call": {
        let result = null;
        try { result = this.handleCall(m.id, m.name, m.args); } catch (e) {
          console.error(e); result = null;
        }
        if (result !== undefined) this.reply(m.id, result);
        break;
      }
      default: break;
    }
  }

  note(msg) { this.screen.note(msg); this.emit("screen"); }

  controlStop() {
    const c = this.app.c;
    if (c.controlStopped) return;
    c.stop();
    c.controlStopped = true;
    c.say("CONTROL STOP - arm will not move until the project restarts");
    for (const k of TOWER_COLORS) this.tower[k] = "OFF";
    this.tower.RED = "BLINK";
    this.note("Arm control stop enabled");
    this.send({ type: "control_stopped" });
    this.emit("tower");
  }

  /** An Arm call from Python. Returns the reply, or undefined if the reply comes later. */
  handleCall(id, name, args) {
    if (name !== "arm") return null;
    const c = this.app.c;
    const [kind, values, wait, timeoutMs] = args;
    const isMove = kind.startsWith("move_");
    if (isMove) {
      if (c.controlStopped) { this.note("Arm is control stopped - movement ignored"); return false; }
      let ok;
      if (kind === "move_to" || kind === "move_inc") {
        let [x, y, z] = values;
        if (kind === "move_inc") {
          const p = c.fk(c.endQ()).position;
          x += p[0]; y += p[1]; z += p[2];
        }
        if (z >= -TILE_CLAMP_MM && z < 0) {
          this.note(`${kind}: z=${fmt(z)} is below the tile surface - simulator uses z=0`);
          z = 0;
        }
        ok = c.moveTo([x, y, z], { label: kind });
        this.moveLog.push([kind, [x, y, z].map((v) => Math.round(v * 10) / 10), !!ok]);
        if (!ok) this.note(`${kind}(${fmt(x)}, ${fmt(y)}, ${fmt(z)}) can't be reached - returned False`);
      } else {
        let ypr = values;
        if (kind === "move_end_effector_inc") {
          const o = c.orientation();
          ypr = [o[0] + values[0], o[1] + values[1], o[2] + values[2]];
        }
        const p = c.fk(c.endQ()).position;
        ok = c.moveTo(p, { ypr, linear: false, label: "move_end_effector_to" });
        this.moveLog.push([kind, ypr, !!ok]);
      }
      if (!ok || !wait) return !!ok;
      this.waiters.push({ id, t: 0, limit: timeoutMs > 0 ? timeoutMs / 1000 : 1e9 });
      return undefined;
    }
    switch (kind) {
      case "set_speed": c.speedPercent = Math.max(1, Math.min(100, values[0] | 0)); return null;
      case "set_end_effector_type": {
        const t = values[0];
        if (c.magnetOn && t !== "MAGNET") c.setMagnet(false);
        c.toolType = t;
        return null;
      }
      case "set_end_effector_magnet": {
        const on = !!values[0];
        if (c.isDone()) c.setMagnet(on); else c.queueCall(() => c.setMagnet(on));
        return null;
      }
      case "set_pen_offset": if (c.toolType === "PEN") c.penOffset = +values[0]; return null;
      case "control_stop": this.controlStop(); return null;
      case "get": {
        const [what, units] = values;
        const p = c.position(), k = unitK(units);
        const r2 = (v) => Math.round(v * 100) / 100;
        if (what === "x") return r2(p[0] / k);
        if (what === "y") return r2(p[1] / k);
        if (what === "z") return r2(p[2] / k);
        const o = c.orientation();
        if (what === "yaw") return r2(o[0]);
        if (what === "roll") return r2(o[1]);
        if (what === "pitch") return r2(o[2]);
        if (what === "is_done") return c.isDone();
        if (what === "is_crashed") return kin.poseProblems(c.q, c.toolLength).length > 0;
        return null;
      }
      case "can_reach": {
        const [mode, v] = values;
        const p = c.position();
        if (mode === "to") return c.canReach(v);
        if (mode === "inc") return c.canReach([p[0] + v[0], p[1] + v[1], p[2] + v[2]]);
        const o = c.orientation();
        const ypr = mode === "ee_inc" ? [o[0] + v[0], o[1] + v[1], o[2] + v[2]] : v;
        return c.canReach(p, ypr);
      }
      default: return null;
    }
  }

  lineText(n) { return n && n > 0 && n <= this.sourceLines.length ? this.sourceLines[n - 1].trim() : ""; }
}

export { cfg };
