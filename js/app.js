// app.js - the Virtual 6-Axis Arm web app: UI wiring, input, update loop.
// Port of the v4 desktop app (six_axis_arm/sim.py) to the browser.
import * as cfg from "./arm_config.js";
import * as kin from "./kinematics.js";
import { ArmController, SceneObject } from "./arm_core.js";
import * as collision from "./collision.js";
import { ReachMap } from "./reach_map.js";
import { ProgramHost, SIM_SPEEDS } from "./program_host.js";
import { Renderer, C_HOUSING, C_SELECTED, C_LIMIT } from "./renderer.js";
import { CodeEditor } from "./editor.js";
import * as cte from "./ctefile.js";
import * as sio from "./scene_io.js";
import { ModelLibrary, toBase64, fromBase64 } from "./model_library.js";
import { detectFileKind, KIND_LABEL, SUPPORTED_SUMMARY } from "./file_formats.js";
import * as bodies from "./bodies.js";
import { AUTOSAVE, PYODIDE_URL } from "../settings.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const css = (c) => `rgb(${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(",")})`;
const f0 = (v) => (Math.round(v) + 0).toFixed(0);
const f1 = (v) => (Math.round(v * 10) / 10 + 0).toFixed(1);

export const HELP_SECTIONS = [
  ["Joints", [["1 - 6", "select a joint"], ["Left / Right", "turn it (Shift = faster) - with no object selected"], ["Slider", "click or drag to set a joint"]]],
  ["Tool", [["W S  A D  R F", "jog the tool in X / Y / Z"], ["T", "type a target X, Y, Z"], ["H", "home (safe position 120, 0, 100)"],
    ["G", "magnet on / off"], ["Tab", "switch tool (magnet / pen)"], ["+ / -", "arm speed up / down"]]],
  ["Program", [["L", "load and run a project from your computer"], ["F5", "run the code in the editor"], ["Space / F8", "pause / resume"],
    ["F10", "step one line"], ["F11", "run to the next arm command"], ["[  ]", "sim speed 0.5x ... 10x"],
    ["B", "press the Signal Tower button"], ["Esc", "stop the program"]]],
  ["Code editor", [["E", "show / hide the code editor"], ["Ctrl+Enter", "run the code (F5 too)"], ["Ctrl+S", "download (keeps the file's format)"],
    ["Ctrl+Z / Y", "undo / redo typing"], ["Export", "download a VEXcode CTE .ctepython"], ["Ctrl+C X V", "copy, cut, paste"],
    ["Tab", "indent 4 spaces (Shift = unindent)"], ["Ctrl+/", "comment lines"], ["Esc", "leave the editor (keys go to the arm)"]]],
  ["Scene", [["Add model", "bundled models, your imports, cube, disk"], ["Import model…", "your own STL / 3MF file (M)"], ["Drop a file", "on the 3D view: model, scene or program"],
    ["P", "place mode: click the platform"], ["Drag", "move an object on the platform"],
    ["Arrows", "nudge the selected object in X / Y by the step"], ["PgUp / PgDn", "raise / lower it (Z) - Shift+Up / Down too"],
    ["Gizmo", "drag an arrow to move along one axis; R switches to rings that turn about X / Y / Z (Shift = free)"], [", .", "turn the selected object about Z by the rotation step"],
    ["Ctrl+Z / Y", "undo / redo scene changes"], ["Delete", "remove the selected object"],
    ["Save scene", "save the platform and objects as .json"], ["Load scene", "open a saved .json scene"],
    ["N", "reset the cubes and disk"], ["C", "clear the pen drawing"]]],
  ["View", [["Mouse", "drag orbit, right-drag pan, wheel zoom"], ["Touch", "1 finger orbit, 2 fingers zoom / pan"], ["F6", "reach map on / off"],
    ["F7", "path trail on / off"], ["V", "reset the view"], ["F1", "show / hide this help"]]],
  ["Panel", [["Header", "click a section title to fold / unfold"], ["Platform", "presets, ± (Shift 50 mm) or type a size"]]],
];
const BAD_WORDS = ["Unreachable", "unreachable", "Blocked", "limit", "Can't", "Error", "Could not", "out of reach", "No project", "only works"];
const STATUS_STYLE = { idle: ["Idle", "#8c93a0"], starting: ["Starting", "#16a34a"], running: ["Running", "#16a34a"], finished: ["Finished", "#2563eb"],
  stopped: ["Stopped", "#d97706"], error: ["Error", "#dc2626"] };
const PATH_TRAIL_MAX = 3000;
const COLLAPSE_KEY = "six-axis-arm.collapsed.v1";
const PREFS_KEY = "six-axis-arm.prefs.v1";
const MOVE_STEPS = [1, 5, 10, 50];
const ROT_STEPS = [1, 5, 15, 45, 90];
const AXIS_INDEX = { x: 0, y: 1, z: 2 };
const CODE_KEY = "six-axis-arm.code.v1";
const OBJ_COLORS = [[0.85, 0.15, 0.15], [0.15, 0.35, 0.9], [0.1, 0.7, 0.3], [0.95, 0.75, 0.1], [0.6, 0.3, 0.8]];
const MODEL_COLORS = [[0.2, 0.72, 0.75], [0.95, 0.6, 0.15], [0.6, 0.4, 0.85], [0.4, 0.7, 0.3]];

class App {
  constructor() {
    this.c = new ArmController();
    this.c.getModels = () => this.models;
    this.c.addDefaultObjects();
    this.moveStep = 10;                // mm per nudge / stepper click
    this.rotStep = 15;                 // degrees per rotation step (gizmo rings snap to it unless Shift is held)
    this.gizmoMode = "move";           // "move" (arrows) | "rotate" (rings)
    this.snapToSurface = true;         // moved objects rest on what is under them
    this.blockOverlaps = true;         // refuse moves into another object (false = warn)
    try {
      const pr = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
      if (MOVE_STEPS.includes(pr.moveStep)) this.moveStep = pr.moveStep;
      if (ROT_STEPS.includes(pr.rotStep)) this.rotStep = pr.rotStep;
    } catch { /* ignore */ }
    const say = this.c.say.bind(this.c);
    this.c.say = (msg) => { say(msg); this.onSay(msg); };
    this.selected = 1;
    this.selectedObject = null;
    this.models = [];
    this.modelCount = 0;
    this.trail = [];             // pen drawing (points, null = pen lifted)
    this.trailVersion = 0;
    this.pathTrail = [];
    this.pathVersion = 0;
    this.showPath = false;
    this.reach = new ReachMap();
    this.showReach = false;
    this.stopOnCollision = { manual: true, program: false };
    this.hits = []; this.selfHits = [];
    this.qSafe = [...this.c.q];
    this.safeHits = new Set();
    this.prevHits = new Set();
    this.history = new sio.SceneHistory();
    this.placeMode = false;
    this.placeItem = { kind: "cube" };
    this.mouseFloor = null;
    this.drag = null;
    this.keys = new Set();
    this.library = new ModelLibrary("models/");
    this.toBase64 = toBase64;
    this.collapsed = { joints: false, tool: false, platform: true, scene: false, overlays: true, program: false, brain: false };
    try { Object.assign(this.collapsed, JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}")); } catch { /* ignore */ }
    this.host = new ProgramHost(this);
    this.lastState = "idle";
    this.lastProject = null;
    this.examples = [];
    this.renderer = new Renderer($("#c3d"), this);
    this.buildUI();
    this.setupPointer();
    this.renderer.attachControls();
    this.editor = new CodeEditor($("#cm"), {
      onRun: () => this.runEditorCode(),
      onSave: () => this.saveCode(),
      onChange: () => this.onEditorChange(),
    });
    this.restoreCode();
    this.host.on((kind) => this.onHost(kind));
    window.addEventListener("resize", () => this.resize());
    new ResizeObserver(() => this.resize()).observe($("#view"));
    this.resize();
    this.setupKeys();
    this.library.refresh();
    this.loadExamples();
    this.ready = this.restoreScene();
    this.last = performance.now();
    this.frames = 0;
    requestAnimationFrame((t) => this.loop(t));
  }

  // =============================================================== toasts ===
  toast(text, bad = null) {
    if (bad === null) bad = BAD_WORDS.some((w) => text.includes(w));
    const box = $("#toasts");
    const life = bad ? 5000 : 3000;
    let el = [...box.children].find((e) => e.dataset.text === text);
    if (!el) {
      el = h("div", { class: "toast" + (bad ? " bad" : "") }, text);
      el.dataset.text = text;
      box.append(el);
      while (box.children.length > 2) box.firstChild.remove();
    }
    el.classList.remove("fade");
    clearTimeout(el._t1); clearTimeout(el._t2);
    el._t1 = setTimeout(() => el.classList.add("fade"), life - 400);
    el._t2 = setTimeout(() => el.remove(), life);
    this.lastToast = text;
  }
  onSay(msg) {
    const bad = BAD_WORDS.some((w) => msg.includes(w));
    if (this.host?.running && !bad && !msg.startsWith("Picked") && !msg.startsWith("Dropped")) return;
    this.toast(msg, bad);
  }

  // =============================================================== layout ===
  resize() {
    const v = $("#view");
    this.renderer.resize(v.clientWidth, v.clientHeight);
  }

  buildUI() {
    for (const sec of $$("[data-sec]")) {
      const key = sec.dataset.sec;
      const head = $(".sec-head", sec);
      head.setAttribute("aria-expanded", String(!this.collapsed[key]));
      head.addEventListener("click", () => this.doAction("toggle", key));
      sec.classList.toggle("collapsed", !!this.collapsed[key]);
    }
    // joints
    const jbox = $("#joints");
    this.jointEls = cfg.JOINT_NAMES.map((name, i) => {
      const [lo, hi] = kin.LIMITS[i];
      const el = h("div", { class: "joint", "data-joint": i },
        h("div", { class: "jh" }, h("span", { class: "jn" }, name), h("span", { class: "jr" }, `${lo}° … ${hi}°`),
          h("span", { class: "pill-lim", hidden: true }, "LIMIT"), h("span", { class: "jv" }, "0.0°")),
        h("div", { class: "slider", role: "slider", tabindex: "-1", "aria-label": name, "aria-valuemin": lo, "aria-valuemax": hi },
          h("div", { class: "tr" }), h("div", { class: "fill" }), h("div", { class: "zero", style: `left:${(0 - lo) / (hi - lo) * 100}%` }), h("div", { class: "knob" })));
      el.addEventListener("pointerdown", (ev) => {
        this.selected = i;
        const sl = $(".slider", el);
        if (ev.target.closest(".slider")) {
          sl.setPointerCapture(ev.pointerId);
          this.sliderDrag = { i, sl };
          this.sliderSet(i, sl, ev.clientX);
          ev.preventDefault();
        }
      });
      el.addEventListener("pointermove", (ev) => { if (this.sliderDrag && this.sliderDrag.i === i) this.sliderSet(i, this.sliderDrag.sl, ev.clientX); });
      const end = () => { this.sliderDrag = null; };
      el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
      jbox.append(el);
      return el;
    });
    // platform presets + typed sizes
    const pr = $("#presets");
    for (const [name, w, d] of cfg.PLATFORM_PRESETS) pr.append(h("button", { "data-action": "platform_preset", "data-arg": `${w},${d}` }, name));
    pr.append(h("button", { class: "ghost reset", "data-action": "platform_reset" }, "Reset"));
    for (const id of ["plat-w", "plat-d"]) {
      const inp = $("#" + id);
      const apply = () => {
        const nums = inp.value.toLowerCase().replace(/mm/g, " ").split(/[x,\s]+/).filter(Boolean).map(Number);
        if (!nums.length || nums.some((n) => !Number.isFinite(n))) { this.toast("Error: type a size in mm, e.g. 333", true); this.syncPanel(true); return; }
        const p = this.c.platform;
        if (nums.length >= 2) this.applyPlatform(nums[0], nums[1]);
        else if (id === "plat-w") { if (nums[0] !== p.width) this.applyPlatform(nums[0], p.depth); }
        else if (nums[0] !== p.depth) this.applyPlatform(p.width, nums[0]);
      };
      inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") inp.blur(); else if (ev.key === "Escape") { inp.value = ""; inp.blur(); } ev.stopPropagation(); });
      inp.addEventListener("blur", () => { if (inp.value.trim()) apply(); this.syncPanel(true); });
    }
    // typed object position (X / Y / Z fields of the selected object)
    for (const [id, axis] of [["sel-x", 0], ["sel-y", 1], ["sel-z", 2]]) {
      const inp = $("#" + id);
      const apply = () => {
        const b = this.selectedObject;
        if (!b) return;
        const v = Number(inp.value.replace(/mm/gi, "").trim());
        if (!Number.isFinite(v)) { this.toast("Error: type a position in mm, e.g. 150", true); this.syncPanel(true); return; }
        const target = [...bodies.origin(b)];
        if (Math.abs(target[axis] - v) < 1e-9) { this.syncPanel(true); return; }
        const zMove = axis === 2;
        target[axis] = v;
        this.setSelectedPosition(target, { axisLabel: "XYZ"[axis], zMove });
      };
      inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") inp.blur(); else if (ev.key === "Escape") { this.syncPanel(true); inp.blur(); } ev.stopPropagation(); });
      inp.addEventListener("blur", () => { if (inp.value.trim()) apply(); this.syncPanel(true); });
    }
    for (const [id, axis] of [["sel-rx", 0], ["sel-ry", 1], ["sel-rz", 2]]) {
      const inp = $("#" + id);
      const apply = () => {
        const b = this.selectedObject;
        if (!b) return;
        const v = Number(inp.value.replace(/°|deg/gi, "").trim());
        if (!Number.isFinite(v)) { this.toast("Error: type an angle in degrees, e.g. 45", true); this.syncPanel(true); return; }
        const next = [...bodies.rot(b)];
        if (Math.abs(bodies.wrapDeg(v) - next[axis]) < 1e-9) { this.syncPanel(true); return; }
        next[axis] = v;
        this.setSelectedRotation(next, "Turn");
      };
      inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") inp.blur(); else if (ev.key === "Escape") { this.syncPanel(true); inp.blur(); } ev.stopPropagation(); });
      inp.addEventListener("blur", () => { if (inp.value.trim()) apply(); this.syncPanel(true); });
    }
    $("#sel-magnetic").addEventListener("change", (ev) => { if (this.selectedObject) this.setMagnetic(this.selectedObject, ev.target.checked); });
    // sim speed
    const seg = $("#sim-seg");
    for (const s of SIM_SPEEDS) seg.append(h("button", { "data-action": "sim_speed", "data-arg": s }, `${s}×`));
    // every button with data-action
    document.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-action]");
      if (!b || b.disabled) return;
      const a = b.dataset.action;
      let arg = b.dataset.arg;
      if (["speed", "reach_height", "sim_speed"].includes(a)) arg = Number(arg);
      else if (a === "platform_step") { const [d, s] = arg.split(","); arg = [d, Number(s), ev.shiftKey]; }
      else if (a === "platform_preset") arg = arg.split(",").map(Number);
      this.doAction(a, arg);
    });
    $("#examples").addEventListener("change", (ev) => {
      const f = ev.target.value;
      ev.target.value = "";
      ev.target.blur();
      if (f) this.openExample(f);
    });
    // every picker is "smart": whatever file is chosen goes where it belongs (model / scene / program)
    for (const [id, expected] of [["#file-project", "program"], ["#file-model", "model"], ["#file-scene", "scene"]]) {
      $(id).addEventListener("change", (ev) => { const files = [...ev.target.files]; ev.target.value = ""; this.openFiles(files, expected); });
    }
    // drag and drop onto the page (the overlay sits over the 3D view)
    const overlay = $("#drop-overlay");
    const hasFiles = (ev) => [...(ev.dataTransfer?.types || [])].includes("Files");
    const showDrop = (on) => { overlay.hidden = !on; $("#view").classList.toggle("dropping", on); };
    window.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      if (!hasFiles(ev)) return;
      ev.dataTransfer.dropEffect = "copy";
      showDrop(true);
      clearTimeout(this._dropHide);
      this._dropHide = setTimeout(() => showDrop(false), 400);   // dragleave is unreliable when leaving the window
    });
    window.addEventListener("dragenter", (ev) => { ev.preventDefault(); if (hasFiles(ev)) showDrop(true); });
    window.addEventListener("drop", (ev) => {
      ev.preventDefault();
      clearTimeout(this._dropHide);
      showDrop(false);
      const files = [...(ev.dataTransfer?.files || [])];
      if (files.length) this.openFiles(files);
    });
    this.buildHelp();
    $("#help").addEventListener("click", () => this.toggleHelp(false));
    $("#prompt").addEventListener("click", (ev) => { if (ev.target.id === "prompt") this.closePrompt(); });
    $("#prompt form").addEventListener("submit", (ev) => { ev.preventDefault(); this.submitPrompt(); });
    $("#prompt-input").addEventListener("keydown", (ev) => { if (ev.key === "Escape") this.closePrompt(); ev.stopPropagation(); });
    document.addEventListener("pointerdown", (ev) => {
      if (!$("#library").hidden && !ev.target.closest("#library") && !ev.target.closest("#btn-add")) this.toggleLibrary(false);
    }, true);
    $("#c3d").addEventListener("contextmenu", (ev) => ev.preventDefault());
    this.syncPanel(true);
  }

  buildHelp() {
    const sec = Object.fromEntries(HELP_SECTIONS);
    const cols = [["Joints", "Tool", "View"], ["Program", "Panel"], ["Code editor", "Scene"]];
    const card = $("#help .card");
    card.innerHTML = "";
    card.append(h("div", { class: "hh" }, h("h2", {}, "Keyboard and mouse"), h("span", { class: "muted small" }, "F1, Esc or click to close")));
    const grid = h("div", { class: "help-cols" });
    for (const col of cols) {
      const c = h("div", { class: "help-col" });
      for (const t of col) {
        c.append(h("h4", { class: "lbl" }, t));
        for (const [k, d] of sec[t]) c.append(h("div", { class: "help-row" }, h("span", { class: "k" }, h("kbd", {}, k)), h("span", {}, d)));
      }
      grid.append(c);
    }
    card.append(grid);
  }

  // ============================================================ pointer ===
  setupPointer() {
    const cv = $("#c3d");
    const pos = (ev) => { const r = cv.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
    // registered BEFORE OrbitControls, so object drags / placing can stop the orbit
    cv.addEventListener("pointerdown", (ev) => {
      const [mx, my] = pos(ev);
      this.pressPos = [mx, my];
      if (ev.button === 2 && this.placeMode) { this.togglePlaceMode(false); ev.stopImmediatePropagation(); return; }
      if (ev.button !== 0) return;
      if (this.placeMode) {
        const fp = this.renderer.floorPoint(mx, my);
        if (fp) this.placeAt(fp[0], fp[1]);
        ev.stopImmediatePropagation();
        return;
      }
      // the move gizmo of the selected object comes first: drag an arrow = move along that axis
      const axis = this.selectedObject && !this.selectedObject.held ? this.renderer.pickGizmo(mx, my) : null;
      if (axis) {
        const started = this.gizmoMode === "rotate" ? this.startRingDrag(this.selectedObject, axis, mx, my) : this.startAxisDrag(this.selectedObject, axis, mx, my);
        if (started) { cv.setPointerCapture(ev.pointerId); ev.stopImmediatePropagation(); }
        return;
      }
      const obj = this.pickObjectRay(mx, my);
      if (obj) {
        this.selectedObject = obj;
        this.syncPanel(true);
        if (this.startObjectDrag(obj, mx, my)) {
          cv.setPointerCapture(ev.pointerId);
          ev.stopImmediatePropagation();
        }
      }
    });
    cv.addEventListener("pointermove", (ev) => {
      const [mx, my] = pos(ev);
      if (this.drag) {
        const d = this.drag;
        if (d.ring) { if (this.dragRingTo(d, mx, my, ev.shiftKey)) d.moved = true; }
        else if (d.axis) { if (this.dragAxisTo(d, mx, my)) d.moved = true; }
        else if (this.dragObjectTo(d.obj, mx, my, d.grab)) d.moved = true;
        ev.stopImmediatePropagation();
      } else if (this.placeMode) {
        this.mouseFloor = this.renderer.floorPoint(mx, my);
      } else if (this.selectedObject && !this.selectedObject.held) {
        const ax = this.renderer.pickGizmo(mx, my);
        if (ax !== this.hoverAxis) { this.hoverAxis = ax; cv.style.cursor = ax ? "grab" : ""; }
      }
    });
    cv.addEventListener("pointerup", (ev) => {
      const [mx, my] = pos(ev);
      if (this.drag) {
        const d = this.drag;
        this.drag = null;
        if (d.moved) {
          if (d.ring) {
            if (this.snapToSurface) bodies.origin(d.obj)[2] = bodies.dropZ(d.obj, this.c.bodies(), { fromAbove: true });
            this.rotatedToast(d.obj, bodies.overlapping(d.obj, this.c.bodies()).map((h) => h.name));
          } else {
            if (d.axis === "z" && this.snapToSurface) this.settleBody(d.obj);   // let go in mid-air: it drops onto what is below
            this.movedToast(d.obj, bodies.overlapping(d.obj, this.c.bodies()).map((h) => h.name), "moved to");
          }
          this.afterMove(d.obj);
        } else this.history.discardIfUnchanged(this);
        ev.stopImmediatePropagation();
        return;
      }
      if (this.pressPos && ev.button === 0 && !this.placeMode && Math.abs(mx - this.pressPos[0]) + Math.abs(my - this.pressPos[1]) < 4) {
        this.selectedObject = this.pickObjectAt(mx, my);
        this.syncPanel(true);
      }
      this.pressPos = null;
    });
    cv.addEventListener("pointercancel", () => { this.drag = null; });
    cv.addEventListener("pointerleave", () => { if (this.placeMode) this.mouseFloor = null; });
  }

  sliderSet(i, sl, clientX) {
    const r = sl.getBoundingClientRect();
    const [lo, hi] = kin.LIMITS[i];
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    this.c.setJoint(i, lo + frac * (hi - lo));
  }

  // =============================================================== keys ===
  setupKeys() {
    const typing = (el) => el && (el.closest?.(".cm-editor") || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName));
    window.addEventListener("keydown", (ev) => {
      this.shiftDown = ev.shiftKey;
      const k = ev.key;
      const ctrl = ev.ctrlKey || ev.metaKey;
      if (!$("#prompt").hidden) return;
      if (!$("#help").hidden && (k === "Escape" || k === "F1")) { ev.preventDefault(); this.toggleHelp(false); return; }
      const fkeys = { F1: () => this.toggleHelp(true), F5: () => this.runEditorCode(), F6: () => this.toggleReach(), F7: () => this.togglePath(),
        F8: () => this.togglePause(), F10: () => this.stepProgram("line"), F11: () => this.stepProgram("command") };
      if (fkeys[k]) { ev.preventDefault(); fkeys[k](); return; }
      if (typing(document.activeElement)) return;
      if (ctrl) {
        const kk = k.toLowerCase();
        if (kk === "z") { ev.preventDefault(); if (ev.shiftKey) this.redoScene(); else this.undoScene(); }
        else if (kk === "y") { ev.preventDefault(); this.redoScene(); }
        else if (kk === "e") { ev.preventDefault(); this.toggleEditor(); }
        else if (kk === "s" && this.showEditor) { ev.preventDefault(); this.saveCode(); }
        return;
      }
      if (ev.altKey) return;
      if (!$("#library").hidden && k === "Escape") { this.toggleLibrary(false); return; }
      if (this.placeMode && k === "Escape") { this.togglePlaceMode(false); return; }
      // a selected object takes the arrow keys (nudges); joints get them back when nothing is selected
      if (this.selectedObject && !this.selectedObject.held) {
        const nudges = { ArrowUp: ["x", 1], ArrowDown: ["x", -1], ArrowRight: ["y", 1], ArrowLeft: ["y", -1], PageUp: ["z", 1], PageDown: ["z", -1] };
        if (nudges[k]) {
          let [axis, sign] = nudges[k];
          if (ev.shiftKey && (k === "ArrowUp" || k === "ArrowDown")) axis = "z";
          ev.preventDefault(); this.nudgeSelected(axis, sign); return;
        }
        if (k === "," || k === ".") { ev.preventDefault(); this.rotateSelectedAxis("z", k === "," ? -1 : 1); return; }
        if (k === "r" || k === "R") { ev.preventDefault(); this.setGizmoMode(this.gizmoMode === "move" ? "rotate" : "move"); return; }
        if (k === "Escape") { this.selectedObject = null; this.syncPanel(true); }
      }
      const lk = k.length === 1 ? k.toLowerCase() : k;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "w", "a", "s", "d", "r", "f"].includes(lk)) {
        this.keys.add(lk.toLowerCase()); ev.preventDefault(); return;
      }
      if (k >= "1" && k <= "6" && k.length === 1) { this.selected = Number(k) - 1; this.syncPanel(true); return; }
      const map = {
        Escape: () => { this.c.stop(); if (this.host.running) this.stopProgram(); else this.toast("Stopped", false); },
        l: () => this.doAction("load"), b: () => this.pressTower(), t: () => this.askTarget(), h: () => this.goHome(),
        g: () => this.toggleMagnet(), Tab: () => this.setTool(this.c.toolType === "MAGNET" ? "PEN" : "MAGNET"),
        "+": () => this.changeSpeed(10), "=": () => this.changeSpeed(10), "-": () => this.changeSpeed(-10),
        c: () => this.clearDrawing(), Delete: () => this.removeSelected(), Backspace: () => this.removeSelected(),
        m: () => this.doAction("import"), n: () => this.resetObjects(), v: () => this.renderer.resetCamera(),
        e: () => this.toggleEditor(), " ": () => this.togglePause(), "[": () => this.changeSimSpeed(-1), "]": () => this.changeSimSpeed(1),
        p: () => this.togglePlaceMode(),
      };
      const fn = map[lk];
      if (fn) { ev.preventDefault(); fn(); this.syncPanel(true); }
    });
    window.addEventListener("keyup", (ev) => { this.shiftDown = ev.shiftKey; this.keys.delete(ev.key.length === 1 ? ev.key.toLowerCase() : ev.key.toLowerCase()); });
    window.addEventListener("blur", () => this.keys.clear());
  }

  handleHeldKeys(dt) {
    if (!this.keys.size || !$("#prompt").hidden || !$("#help").hidden) return;
    if (this.host.running && this.host.paused) return;
    const fast = this.shiftDown ? 3 : 1;
    let d = 0;
    if (this.keys.has("arrowright") || this.keys.has("arrowup")) d += 1;
    if (this.keys.has("arrowleft") || this.keys.has("arrowdown")) d -= 1;
    if (d) this.c.jogJoint(this.selected, d * 40 * fast * dt);
    const v = [0, 0, 0];
    for (const [key, vec] of [["w", [1, 0, 0]], ["s", [-1, 0, 0]], ["a", [0, 1, 0]], ["d", [0, -1, 0]], ["r", [0, 0, 1]], ["f", [0, 0, -1]]]) {
      if (this.keys.has(key)) for (let i = 0; i < 3; i++) v[i] += vec[i];
    }
    if (v.some(Boolean)) this.cartesianJog(kin.scale(v, 60 * fast * dt));
  }

  cartesianJog(delta) {
    const c = this.c;
    c.stop();
    const fk = c.fk();
    const res = kin.solveIK(kin.add(fk.position, delta), { qInit: c.q, targetRot: fk.rotation, toolLength: c.toolLength, maxIters: 40, restarts: 1 });
    if (res.success && Math.max(...res.q.map((v, i) => Math.abs(v - c.q[i]))) < 15) c.setJoints(res.q);
    else this.toast("Can't jog further that way (" + (res.reason || "limit") + ")", true);
  }

  // ============================================================ actions ===
  doAction(action, arg) {
    switch (action) {
      case "load": $("#file-project").click(); break;
      case "run": this.runEditorCode(); break;
      case "stop": this.c.stop(); this.stopProgram(); break;
      case "home": this.goHome(); break;
      case "import": this.toggleLibrary(false); $("#file-model").click(); break;
      case "reset_view": this.renderer.resetCamera(); break;
      case "help": this.toggleHelp(); break;
      case "tool": this.setTool(arg); break;
      case "magnet": this.toggleMagnet(); break;
      case "speed": this.changeSpeed(arg); break;
      case "objects_reset": this.resetObjects(); break;
      case "objects_clear": this.clearObjects(); break;
      case "toggle":
        this.collapsed[arg] = !this.collapsed[arg];
        try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(this.collapsed)); } catch { /* private mode */ }
        for (const s of $$(`[data-sec="${arg}"]`)) { s.classList.toggle("collapsed", this.collapsed[arg]); $(".sec-head", s).setAttribute("aria-expanded", String(!this.collapsed[arg])); }
        break;
      case "clear_drawing": this.clearDrawing(); break;
      case "platform_step": {
        const [dim, sign, shift] = arg;
        const step = shift ? 50 : 10;
        const p = this.c.platform;
        this.applyPlatform(p.width + (dim === "w" ? sign * step : 0), p.depth + (dim === "d" ? sign * step : 0));
        break;
      }
      case "platform_preset": this.applyPlatform(...arg); break;
      case "platform_reset": this.applyPlatform(...cfg.PLATFORM_SIZE); break;
      case "tower": this.pressTower(); break;
      case "code": this.toggleEditor(); break;
      case "editor_run": this.runEditorCode(); break;
      case "editor_save": this.saveCode(); break;
      case "editor_export": this.exportCode(); break;
      case "editor_new": this.newCode(); break;
      case "pause": this.togglePause(); break;
      case "step": this.stepProgram(arg || "line"); break;
      case "sim_speed": this.setSimSpeed(arg); break;
      case "library": this.toggleLibrary(); break;
      case "place": this.togglePlaceMode(); break;
      case "scene_save": this.saveScene(); break;
      case "scene_load": $("#file-scene").click(); break;
      case "undo": this.undoScene(); break;
      case "redo": this.redoScene(); break;
      case "nudge": { const [axis, sign] = String(arg).split(","); this.nudgeSelected(axis, Number(sign)); break; }
      case "step_size": this.setMoveStep(Number(arg)); break;
      case "rotate": this.rotateSelectedAxis("z", Math.sign(Number(arg)) || 1); break;
      case "rotate_axis": { const [axis, sign] = String(arg).split(","); this.rotateSelectedAxis(axis, Number(sign)); break; }
      case "rot_step": this.setRotStep(Number(arg)); break;
      case "gizmo_mode": this.setGizmoMode(arg); break;
      case "lay_flat": this.layFlatSelected(); break;
      case "reset_rotation": this.setSelectedRotation([0, 0, 0], "Reset rotation"); break;
      case "drop": this.dropSelected(); break;
      case "snap": this.snapToSurface = !this.snapToSurface; this.toast(`Snap to surface ${this.snapToSurface ? "on" : "off"}`, false); this.sceneChanged(false); break;
      case "block_overlap": this.blockOverlaps = !this.blockOverlaps; this.toast(`Overlapping objects: ${this.blockOverlaps ? "blocked" : "allowed (warn only)"}`, false); this.sceneChanged(false); break;
      case "reach": this.toggleReach(); break;
      case "reach_band": this.reach.showBand = !this.reach.showBand; this.sceneChanged(false); break;
      case "reach_height": this.reach.height = Math.max(10, Math.min(300, this.reach.height + arg)); this.sceneChanged(false); break;
      case "path": this.togglePath(); break;
      case "path_clear": this.pathTrail = []; this.pathVersion++; this.toast("Path trail cleared", false); break;
      case "collide_stop":
        this.stopOnCollision[arg] = !this.stopOnCollision[arg];
        this.toast(`Stop on collision for ${arg === "manual" ? "manual moves" : "programs"}: ${this.stopOnCollision[arg] ? "on" : "off (warn only)"}`, false);
        this.sceneChanged(false);
        break;
      default: break;
    }
    this.syncPanel(true);
  }

  goHome() { this.c.goHome(); this.toast("Going to the safe position (120, 0, 100)", false); }
  toggleMagnet() {
    if (this.c.toolType !== "MAGNET") { this.toast("The magnet only works with the magnet tool", true); return; }
    const n = this.c.events.length, last = this.c.events.at(-1);
    this.c.setMagnet(!this.c.magnetOn);
    if (this.c.events.length === n && this.c.events.at(-1) === last) this.toast(`Magnet ${this.c.magnetOn ? "on" : "off"}`, false);
  }
  setTool(tool) {
    const c = this.c;
    if (tool === c.toolType) return;
    const old = [c.toolType, c.penOffset];
    if (c.magnetOn) c.setMagnet(false);
    c.toolType = tool;
    if (tool === "PEN") c.penOffset = cfg.TYPICAL_PEN_OFFSET;
    if (kin.poseProblems(c.q, c.toolLength).length) {
      [c.toolType, c.penOffset] = old;
      this.toast("Can't switch tool here - the pen would hit the table. Move up first.", true);
    } else this.toast(`Tool: ${tool.toLowerCase()}`, false);
  }
  changeSpeed(d) { this.c.speedPercent = Math.max(10, Math.min(100, this.c.speedPercent + d)); this.toast(`Speed ${this.c.speedPercent}%`, false); }
  clearDrawing() {
    const had = this.hasDrawing();
    this.trail = []; this.trailVersion++;
    this.toast(had ? "Pen drawing cleared" : "Nothing to clear - the pen hasn't drawn anything", !had);
  }
  hasDrawing() { return this.trail.some((p, i) => p && i > 0 && this.trail[i - 1]); }
  strokes() { let n = 0; this.trail.forEach((p, i) => { if (p && this.trail[i + 1] && (i === 0 || !this.trail[i - 1])) n++; }); return n; }
  toggleHelp(on = null) { $("#help").hidden = !(on === null ? $("#help").hidden : on); }
  toggleReach(on = null) {
    this.showReach = on === null ? !this.showReach : on;
    this.toast(this.showReach ? "Reach map on (green = tool can point straight down there)" : "Reach map off", false);
    this.sceneChanged(false);
  }
  togglePath(on = null) {
    this.showPath = on === null ? !this.showPath : on;
    this.toast(this.showPath ? "Path trail on" : "Path trail off", false);
    this.sceneChanged(false);
  }
  pressTower() {
    if (this.host.pressTower()) this.toast("Signal Tower button pressed", false);
    else this.toast("The Signal Tower button only works while a project runs", true);
  }

  // ------------------------------------------------------------- prompt ---
  askTarget() {
    const p = this.c.position();
    this.openPrompt("target", "Move the tool to X, Y, Z (mm)", `${f0(p[0])}, ${f0(p[1])}, ${f0(p[2])}`);
  }
  openPrompt(kind, label, text) {
    this.promptKind = kind;
    $("#prompt-label").textContent = label;
    const inp = $("#prompt-input");
    inp.value = text;
    $("#prompt").hidden = false;
    inp.focus(); inp.select();
  }
  closePrompt() { $("#prompt").hidden = true; }
  submitPrompt() {
    const text = $("#prompt-input").value.trim();
    const kind = this.promptKind;
    this.closePrompt();
    if (!text) return;
    try {
      if (kind === "target") {
        const nums = text.replace(/,/g, " ").split(/\s+/).map(Number);
        if (![3, 6].includes(nums.length) || nums.some((n) => !Number.isFinite(n))) throw new Error("type 3 numbers: x, y, z  (or 6 with yaw roll pitch)");
        this.goToTarget(nums.slice(0, 3), nums.length === 6 ? nums.slice(3) : null);
      }
    } catch (e) { this.toast(`Error: ${e.message}`, true); }
  }
  goToTarget(xyz, ypr = null) {
    const c = this.c;
    if (ypr) return c.moveTo(xyz, { ypr, label: "target" });
    if (c.moveTo(xyz, { toolDown: true, label: "target" })) return true;
    if (c.moveTo(xyz, { keepOrientation: false, label: "target" })) {
      c.say(`Moving to (${f0(xyz[0])}, ${f0(xyz[1])}, ${f0(xyz[2])}) - tool can't point straight down there, orientation relaxed`);
      return true;
    }
    return false;
  }

  // ============================================================ models ===
  freeSpot(hx, hy, prefer = [180, 0]) {
    const p = this.c.platform;
    const [x0, x1, y0, y1] = p.bounds();
    const taken = [];
    for (const it of this.sceneItems()) {
      if (it.obj.held) continue;
      const [lo, hi] = this.objectBounds(it.obj);
      taken.push([lo[0], hi[0], lo[1], hi[1]]);
    }
    const cands = [];
    for (let x = x0 + hx; x <= x1 - hx + 0.01; x += 20) for (let y = y0 + hy; y <= y1 - hy + 0.01; y += 20) cands.push([x, y]);
    const score = ([x, y]) => Math.abs(Math.hypot(x, y) - 200) + 0.3 * Math.hypot(x - prefer[0], y - prefer[1]);
    cands.sort((a, b) => score(a) - score(b));
    for (const [x, y] of cands) {
      if (Math.hypot(x, y) < cfg.BASE_RADIUS + Math.max(hx, hy) + 15) continue;
      if (taken.every(([a0, a1, b0, b1]) => x + hx + 15 <= a0 || x - hx - 15 >= a1 || y + hy + 15 <= b0 || y - hy - 15 >= b1)) return [x, y];
    }
    return p.clamp(prefer[0], prefer[1], hx, hy) || p.center;
  }
  uniqueName(name) {
    const taken = new Set([...this.models.map((m) => m.name), ...this.c.objects.map((o) => o.name)]);
    if (!taken.has(name)) return name;
    let n = 2;
    while (taken.has(`${name} (${n})`)) n++;
    return `${name} (${n})`;
  }
  async addModel(source, name, { pos = null, record = true } = {}) {
    try {
      const m = await this.library.load(source, name);
      m.color = MODEL_COLORS[this.modelCount % MODEL_COLORS.length];
      m.name = this.uniqueName(name);
      const [x, y] = pos || this.freeSpot(...m.halfSize());
      if (record) this.history.push(this, `Add ${m.name}`);
      m.offset = [x, y, 0];
      this.models.push(m);
      if (this.snapToSurface) m.offset[2] = bodies.dropZ(m, this.c.bodies(), { fromAbove: true });   // e.g. placed onto a pallet
      this.modelCount++;
      this.selectedObject = m;
      const s = m.size();
      const notes = m.notes?.length ? ` · ${m.notes.join(" · ")}` : "";
      this.toast(`Added ${m.name}  (${f0(s[0])} x ${f0(s[1])} x ${f0(s[2])} mm)${notes}`, false);
      this.sceneChanged();
      return m;
    } catch (e) {
      this.toast(`Could not import ${name}: ${e.message}`, true);
      return null;
    }
  }
  // ------------------------------------------------------------ any file ---
  /** Files from a picker or a drop. `expected` is what the picker was for; a
   * file of another kind is still opened the right way, with a toast saying so. */
  async openFiles(files, expected = null) {
    const out = [];
    for (const f of files) out.push(await this.openFile(f, expected));
    return out;
  }
  async openFile(file, expected = null) {
    let buf;
    try { buf = await file.arrayBuffer(); } catch (e) { this.toast(`Can't read ${file.name}: ${e.message}`, true); return null; }
    const kind = detectFileKind(file.name, buf);
    if (!kind) { this.toast(`Can't open ${file.name} - supported files are ${SUPPORTED_SUMMARY}`, true); return null; }
    if (expected && kind !== expected) {
      const doing = { model: "importing it as a model", scene: "loading it as a scene", program: "opening it as a program" }[kind];
      this.toast(`${file.name} is ${KIND_LABEL[kind]}, not ${KIND_LABEL[expected]} - ${doing}`, false);
    }
    if (kind === "model") return this.importModelFile(file, buf);
    if (kind === "scene") return this.loadSceneFile(file, buf);
    return this.loadProjectFile(file, { buf });
  }
  async importModelFile(file, buf = null) {
    try {
      buf = buf || await file.arrayBuffer();
      if (detectFileKind(file.name, buf) !== "model") throw new Error("only .stl and .3mf models can be imported");
      let key;
      try { key = await this.library.store(file.name, buf); } catch (e) {
        console.warn("IndexedDB not available - the model is used for this visit only", e);
        return this.addModel({ data: buf }, file.name);
      }
      await this.library.refresh();
      const m = await this.addModel({ stored: key }, key);
      if (!m) {                                            // unreadable file: don't keep it in the library
        try { await this.library.removeStored(key); await this.library.refresh(); } catch { /* ignore */ }
      }
      return m;
    } catch (e) { this.toast(`Could not import ${file.name}: ${e.message}`, true); return null; }
  }
  addBuiltin(kind, pos = null, record = true) {
    const names = new Set(this.c.objects.map((o) => o.name));
    const base = kind === "cube" ? "Cube" : "Disk";
    let n = 1;
    while (names.has(`${base} ${n}`)) n++;
    const col = OBJ_COLORS[(n - 1) % OBJ_COLORS.length];
    const [size, height] = kind === "cube" ? [25, 25] : [30, 8];
    const [x, y] = pos || this.freeSpot(size / 2, size / 2);
    const ob = new SceneObject(`${base} ${n}`, kind, [x, y, 0], { size, height, color: col });
    if (record) this.history.push(this, `Add ${ob.name}`);
    this.c.objects.push(ob);
    if (this.snapToSurface) ob.pos[2] = bodies.dropZ(ob, this.c.bodies(), { fromAbove: true });
    this.selectedObject = ob;
    this.toast(`Added ${ob.name} at (${f0(x)}, ${f0(y)})`, false);
    this.sceneChanged();
    return ob;
  }
  itemLabel(item) { return item.kind === "cube" ? "Cube" : item.kind === "disk" ? "Disk" : item.name; }
  libraryPick(item) {
    this.toggleLibrary(false);
    if (this.placeMode) {
      this.placeItem = item;
      this.placeItemHalf();
      this.toast(`Place mode: click the platform to add ${this.itemLabel(item)}. Esc to stop`, false);
      this.syncPanel(true);
      return null;
    }
    if (item.kind === "cube" || item.kind === "disk") return this.addBuiltin(item.kind);
    return this.addModel(item.source, item.name);
  }
  togglePlaceMode(on = null) {
    this.placeMode = on === null ? !this.placeMode : on;
    if (this.placeMode) this.toast(`Place mode: click the platform to add ${this.itemLabel(this.placeItem)}. Esc to stop`, false);
    else { this.mouseFloor = null; this.toast("Place mode off", false); }
    this.syncPanel(true);
  }
  async placeItemHalf() {
    const it = this.placeItem;
    if (it.kind === "cube") return [12.5, 12.5, 25];
    if (it.kind === "disk") return [15, 15, 8];
    this.placeSizes = this.placeSizes || new Map();
    const k = JSON.stringify(it.source);
    if (!this.placeSizes.has(k)) {
      this.placeSizes.set(k, [20, 20, 20]);
      try { const m = await this.library.load(it.source, it.name); const [hx, hy] = m.halfSize(); this.placeSizes.set(k, [hx, hy, m.size()[2]]); } catch { /* keep default */ }
    }
    return this.placeSizes.get(k);
  }
  placeHalfNow() {
    const it = this.placeItem;
    if (it.kind === "cube") return [12.5, 12.5, 25];
    if (it.kind === "disk") return [15, 15, 8];
    return this.placeSizes?.get(JSON.stringify(it.source)) || [20, 20, 20];
  }
  async placeAt(x, y) {
    const [hx, hy] = await this.placeItemHalf();
    if (!this.c.platform.contains(x, y, hx, hy)) { this.toast("That spot is off the platform - click inside the outline", true); return null; }
    const it = this.placeItem;
    if (it.kind === "cube" || it.kind === "disk") return this.addBuiltin(it.kind, [x, y]);
    return this.addModel(it.source, it.name, { pos: [x, y] });
  }

  // ------------------------------------------------------- library popup ---
  async toggleLibrary(open = null) {
    const pop = $("#library");
    const show = open === null ? pop.hidden : open;
    pop.hidden = !show;
    $("#btn-add").classList.toggle("active", show);
    if (!show) return;
    this.renderLibrary();
    await this.library.refresh();
    if (!pop.hidden) this.renderLibrary();
  }
  renderLibrary() {
    const pop = $("#library");
    const lib = this.library;
    const isOn = (it) => this.placeMode && JSON.stringify(this.placeItem) === JSON.stringify(it);
    const row = (it, name, info, col, extra = null) => h("button", { class: "it" + (isOn(it) ? " on" : ""), "data-name": name,
      onclick: (ev) => { if (!ev.target.closest(".del")) this.libraryPick(it); } },
    h("span", { class: "sw", style: `background:${col}` }), h("span", { class: "nm", title: name }, name), h("span", { class: "inf" }, info), extra);
    const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;
    pop.innerHTML = "";
    pop.append(h("div", { class: "ph" }, "Add to the scene", h("button", { class: "ghost small", onclick: async () => {
      await lib.refresh(); this.renderLibrary(); this.toast(`${lib.bundled.length + lib.stored.length} model files`, false);
    } }, "Refresh")));
    const body = h("div", { class: "pb" });
    body.append(h("div", { class: "lbl pg" }, "Magnetic · the magnet can pick these up"));
    body.append(row({ kind: "cube" }, "Cube", "25 mm", "#d92626"), row({ kind: "disk" }, "Disk", "30 × 8 mm", "#16a34a"));
    body.append(h("div", { class: "lbl pg" }, "Models folder · models/"));
    if (!lib.bundled.length) body.append(h("div", { class: "empty" }, "No models listed in models/index.json"));
    for (const m of lib.bundled) {
      const nm = m.name || m.file;
      body.append(row({ kind: "model", source: { library: "models/" + m.file }, name: nm }, nm, m.info || m.file.split(".").pop().toUpperCase(), "#0891b2"));
    }
    body.append(h("div", { class: "lbl pg" }, "Imported · kept in this browser"));
    if (!lib.stored.length) body.append(h("div", { class: "empty" }, "Nothing imported yet - use Import model… or drop an STL / 3MF on the 3D view"));
    for (const s of lib.stored) {
      const del = h("span", { class: "del", role: "button", title: `Forget ${s.name}`, onclick: async (ev) => {
        ev.stopPropagation();
        await lib.removeStored(s.key); await lib.refresh(); this.renderLibrary();
        this.toast(`Removed ${s.name} from this browser's library`, false);
      } }, "✕");
      body.append(row({ kind: "model", source: { stored: s.key }, name: s.name }, s.name, `${s.fmt} · ${kb(s.size)}`, "#7c3aed", del));
    }
    pop.append(body);
    pop.append(h("div", { class: "pf" }, h("span", { class: "muted small" }, this.placeMode ? "Pick one, then click the platform" : "Click to add · P = place mode"),
      h("button", { "data-action": "import", title: "Import your own STL / 3MF model from your computer" }, "Import model…")));
    const b = $("#btn-add").getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 16);
    pop.style.width = w + "px";
    pop.style.left = Math.max(8, Math.min(b.left, window.innerWidth - w - 8)) + "px";
    const ph = pop.offsetHeight;
    let top = b.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, b.top - 6 - ph);
    pop.style.top = top + "px";
  }

  // --------------------------------------------------------- moving objects ---
  objectBounds(obj) { return bodies.aabb(obj); }
  objHalf(obj) { return bodies.halfSize(obj); }
  /** Try to put `body`'s origin at `target` (mm). Clamps to the platform, keeps it above
   *  the Tile, applies snap-to-surface (when `snap`) and the overlap rule.
   *  -> {ok, blocked: [names]} ; on a blocked move the body is left where it was. */
  moveBody(body, target, { snap = this.snapToSurface, settle = "above" } = {}) {
    const o = bodies.origin(body), prev = [...o];
    const [hx, hy] = bodies.halfSize(body);
    const spot = this.c.platform.clamp(target[0], target[1], hx, hy) || [target[0], target[1]];
    const zMin = o[2] - bodies.bottomZ(body);                       // origin z when the bottom touches the Tile
    bodies.setOrigin(body, [spot[0], spot[1], Math.max(zMin, target[2])]);
    const others = this.c.bodies();
    if (snap) bodies.origin(body)[2] = bodies.dropZ(body, others, { fromAbove: settle === "above" });
    const hits = bodies.overlapping(body, others);
    if (hits.length && this.blockOverlaps) { bodies.setOrigin(body, prev); return { ok: false, blocked: hits.map((h) => h.name) }; }
    return { ok: true, blocked: hits.map((h) => h.name) };
  }
  /** After any manual move: things that were resting on the moved body fall, the UI updates. */
  afterMove(body) {
    if (this.snapToSurface) this.settleOthers(body);
    this.sceneChanged();
  }
  settleBody(body) { bodies.origin(body)[2] = bodies.dropZ(body, this.c.bodies(), { fromAbove: false }); }
  settleOthers(except = null) {
    const all = this.c.bodies().filter((b) => !b.held && b !== except).sort((a, b) => bodies.bottomZ(a) - bodies.bottomZ(b));
    for (const b of all) if (bodies.bottomZ(b) > 0.01) this.settleBody(b);
  }
  blockedToast(body, blocked) { this.toast(`Can't move ${body.name} there - it would overlap ${blocked.slice(0, 2).join(" and ")}`, true); }
  /** "Cube 3 at (150, 160, 0)" plus " - overlaps Cube 4" when the overlap rule is set to warn. */
  movedToast(body, blocked = [], verb = "at") {
    const p = bodies.origin(body);
    const note = blocked.length ? ` - overlaps ${blocked.slice(0, 2).join(" and ")}` : "";
    this.toast(`${body.name} ${verb} (${f0(p[0])}, ${f0(p[1])}, ${f0(p[2])})${note}`, blocked.length > 0);
  }

  setMoveStep(step) {
    if (!MOVE_STEPS.includes(step)) return;
    this.moveStep = step;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ moveStep: step, rotStep: this.rotStep })); } catch { /* ignore */ }
    this.syncPanel(true);
  }
  /** Move the selected object by one step along an axis (keyboard / stepper). */
  nudgeSelected(axis, sign) {
    const b = this.selectedObject;
    if (!b) { this.toast("Nothing selected - click an object first", true); return false; }
    if (b.held) { this.toast(`Can't move ${b.name} - the magnet is holding it`, true); return false; }
    const i = AXIS_INDEX[axis];
    if (i === undefined) return false;
    const target = [...bodies.origin(b)];
    target[i] += sign * this.moveStep;
    return this.setSelectedPosition(target, { axisLabel: axis.toUpperCase(), zMove: axis === "z" });
  }
  /** Put the selected object at an absolute position (typed values or a nudge). */
  setSelectedPosition(target, { axisLabel = "", zMove = false } = {}) {
    const b = this.selectedObject;
    if (!b || b.held) return false;
    const before = [...bodies.origin(b)];
    this.history.push(this, `Move ${b.name}${axisLabel ? " " + axisLabel : ""}`, 1200);
    // a deliberate Z move is honoured even with snap on - unless it is a move *down*, which drops onto the surface
    const snap = this.snapToSurface && (!zMove || target[2] < before[2]);
    const r = this.moveBody(b, target, { snap, settle: zMove ? "gravity" : "above" });
    if (!r.ok) { this.history.discardIfUnchanged(this); this.blockedToast(b, r.blocked); this.syncPanel(true); return false; }
    const p = bodies.origin(b);
    if (p.every((v, k) => Math.abs(v - before[k]) < 1e-9)) { this.history.discardIfUnchanged(this); this.syncPanel(true); return false; }
    this.movedToast(b, r.blocked);
    this.afterMove(b);
    return true;
  }
  setRotStep(step) {
    if (!ROT_STEPS.includes(step)) return;
    this.rotStep = step;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ moveStep: this.moveStep, rotStep: step })); } catch { /* ignore */ }
    this.syncPanel(true);
  }
  setGizmoMode(mode) {
    this.gizmoMode = mode === "rotate" ? "rotate" : "move";
    this.toast(this.gizmoMode === "rotate" ? "Rotate: drag a ring to turn the object (Shift = free rotation)" : "Move: drag an arrow to move along one axis", false);
    this.syncPanel(true);
  }
  rotatedToast(body, blocked = []) {
    const r = bodies.rot(body), note = blocked.length ? ` - overlaps ${blocked.slice(0, 2).join(" and ")}` : "";
    this.toast(`${body.name} turned to (${f0(r[0])}°, ${f0(r[1])}°, ${f0(r[2])}°)${note}`, blocked.length > 0);
  }
  /** Set the selected object's rotation (Euler degrees about X, Y, Z). It turns about its
   *  centre, is lifted if a corner went under the Tile, snaps to the surface below, and
   *  obeys the overlap rule. */
  setSelectedRotation(rotDeg, label = "Turn") {
    const b = this.selectedObject;
    if (!b) { this.toast("Nothing selected - click an object first", true); return false; }
    if (b.held) { this.toast(`Can't turn ${b.name} - the magnet is holding it`, true); return false; }
    const before = { rot: [...bodies.rot(b)], o: [...bodies.origin(b)] };
    this.history.push(this, `${label} ${b.name}`, 1200);
    bodies.setRotation(b, rotDeg);
    if (this.snapToSurface) bodies.origin(b)[2] = bodies.dropZ(b, this.c.bodies(), { fromAbove: true });
    const hits = bodies.overlapping(b, this.c.bodies());
    if (hits.length && this.blockOverlaps) {
      b.rot = before.rot; bodies.setOrigin(b, before.o); bodies.invalidateSamples(b);
      this.history.discardIfUnchanged(this); this.blockedToast(b, hits.map((h) => h.name)); this.syncPanel(true); return false;
    }
    if (bodies.rot(b).every((v, k) => Math.abs(v - before.rot[k]) < 1e-9) && bodies.origin(b).every((v, k) => Math.abs(v - before.o[k]) < 1e-9)) { this.history.discardIfUnchanged(this); this.syncPanel(true); return false; }
    this.rotatedToast(b, hits.map((h) => h.name));
    this.afterMove(b);
    return true;
  }
  /** Turn by one rotation step about a world axis (steppers, keys). */
  rotateSelectedAxis(axis, sign) {
    const b = this.selectedObject;
    if (!b) { this.toast("Nothing selected - click an object first", true); return false; }
    if (!"xyz".includes(axis)) return false;
    // step one Euler component; for an object with no tilt this is a turn about the world axis
    const next = [...bodies.rot(b)];
    next[AXIS_INDEX[axis]] += sign * this.rotStep;
    return this.setSelectedRotation(next, "Turn");
  }
  layFlatSelected() {
    const b = this.selectedObject;
    if (!b) { this.toast("Nothing selected - click an object first", true); return false; }
    const r = bodies.rot(b);
    if (Math.abs(r[0]) < 1e-9 && Math.abs(r[1]) < 1e-9) { this.toast(`${b.name} is already flat`, false); return false; }
    return this.setSelectedRotation([0, 0, r[2]], "Lay flat");
  }
  startRingDrag(obj, axis, mx, my) {
    if (obj.held) return false;
    const center = bodies.center(obj);
    const a0 = this.renderer.ringAngle(mx, my, center, axis);
    if (a0 === null) return false;
    this.history.push(this, `Turn ${obj.name}`);
    this.drag = { obj, ring: axis, center, a0, startR: bodies.rotationMatrix(obj).map((row) => [...row]), startO: [...bodies.origin(obj)], moved: false, lastAngle: 0 };
    return true;
  }
  dragRingTo(d, mx, my, free = false) {
    const a = this.renderer.ringAngle(mx, my, d.center, d.ring);
    if (a === null) return false;
    let theta = a - d.a0;
    theta = ((theta + 180) % 360 + 360) % 360 - 180;
    if (!free) theta = Math.round(theta / this.rotStep) * this.rotStep;
    if (theta === d.lastAngle) return false;
    d.lastAngle = theta;
    const b = d.obj;
    b.rot = [...bodies.eulerFromMatrix(d.startR)]; bodies.setOrigin(b, d.startO); bodies.invalidateSamples(b);
    bodies.setRotationMatrix(b, bodies.mul3(bodies.axisRotation(d.ring, theta), d.startR));
    const hits = bodies.overlapping(b, this.c.bodies());
    if (hits.length && this.blockOverlaps) { b.rot = bodies.eulerFromMatrix(d.startR); bodies.setOrigin(b, d.startO); bodies.invalidateSamples(b); return false; }
    return true;
  }
  dropSelected() {
    const b = this.selectedObject;
    if (!b || b.held) { this.toast(b ? `${b.name} is held by the magnet` : "Nothing selected", true); return false; }
    const before = bodies.origin(b)[2];
    this.history.push(this, `Drop ${b.name}`);
    this.settleBody(b);
    if (Math.abs(bodies.origin(b)[2] - before) < 1e-9) { this.history.discardIfUnchanged(this); this.toast(`${b.name} is already resting`, false); return false; }
    this.toast(`${b.name} dropped to z = ${f0(bodies.origin(b)[2])}`, false);
    this.afterMove(b);
    return true;
  }
  setMagnetic(model, on) {
    if (!bodies.isModel(model)) return;
    model.magnetic = !!on;
    if (model.source?.stored) this.library.setStoredMagnetic(model.source.stored, on).catch(() => {});
    this.toast(`${model.name}: the magnet ${on ? "can" : "can't"} pick it up`, false);
    this.sceneChanged();
  }

  // ------------------------------------------------------------- dragging ---
  startAxisDrag(obj, axis, mx, my) {
    if (obj.held) return false;
    const center = this.gizmoCenter(obj);
    const dir = [axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0];
    this.history.push(this, `Move ${obj.name} ${axis.toUpperCase()}`);
    this.drag = { obj, axis, dir, center, t0: this.renderer.axisParam(mx, my, center, dir), start: [...bodies.origin(obj)], moved: false };
    return true;
  }
  dragAxisTo(d, mx, my) {
    const t = this.renderer.axisParam(mx, my, d.center, d.dir);
    const target = d.start.map((v, k) => v + d.dir[k] * (t - d.t0));
    const snap = this.snapToSurface && d.axis !== "z";
    return this.moveBody(d.obj, target, { snap, settle: "above" }).ok;
  }
  gizmoCenter(obj) { const [lo, hi] = bodies.aabb(obj); return this.gizmoMode === "rotate" ? bodies.center(obj) : [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[2] + 1]; }
  pickObjectRay(mx, my, pad = 3) {
    const ray = this.renderer.ray(mx, my);
    let best = null, bt = null;
    for (const { obj } of this.sceneItems()) {
      const [lo, hi] = this.objectBounds(obj);
      const t = Renderer.rayBox(ray, lo.map((v) => v - pad), hi.map((v) => v + pad));
      if (t !== null && (bt === null || t < bt)) { best = obj; bt = t; }
    }
    return best;
  }
  pickObjectAt(mx, my) {
    let best = null, bd = 45;
    for (const { obj } of this.sceneItems()) {
      const [lo, hi] = this.objectBounds(obj);
      const sp = this.renderer.project(lo.map((v, k) => (v + hi[k]) / 2));
      if (sp) { const d = Math.hypot(sp[0] - mx, sp[1] - my); if (d < bd) { best = obj; bd = d; } }
    }
    return best;
  }
  startObjectDrag(obj, mx, my) {
    if (obj.held) { this.toast(`Can't move ${obj.name} - the magnet is holding it`, true); return false; }
    // grab on the plane through the object's bottom, so a stacked object drags where it is
    const fp = this.renderer.floorPoint(mx, my, bodies.bottomZ(obj));
    if (!fp) return false;
    const p = bodies.origin(obj);
    this.history.push(this, `Move ${obj.name}`);
    this.drag = { obj, grab: [p[0] - fp[0], p[1] - fp[1]], planeZ: bodies.bottomZ(obj), moved: false };
    return true;
  }
  dragObjectTo(obj, mx, my, grab) {
    if (obj.held) return false;
    const fp = this.renderer.floorPoint(mx, my, this.drag?.planeZ ?? 0);
    if (!fp) return false;
    const o = bodies.origin(obj);
    return this.moveBody(obj, [fp[0] + grab[0], fp[1] + grab[1], o[2]], { settle: "above" }).ok;
  }

  // ------------------------------------------------------ scene objects ---
  sceneItems() {
    const items = this.c.objects.map((ob) => ({ obj: ob, name: ob.name, type: ob.kind[0].toUpperCase() + ob.kind.slice(1), pos: ob.pos, held: ob.held, color: ob.color }));
    for (const m of this.models) items.push({ obj: m, name: m.name, type: m.fmt, pos: m.offset, held: !!m.held, color: m.color });
    return items;
  }
  objectOnPlatform(obj) {
    if (obj.offset) { const [hx, hy] = obj.halfSize(); return this.c.platform.contains(obj.offset[0], obj.offset[1], hx, hy); }
    return this.c.onPlatform(obj);
  }
  removeObject(obj) {
    if (!obj) return false;
    this.history.push(this, `Remove ${obj.name}`);
    if (this.selectedObject === obj) this.selectedObject = null;
    const i = this.models.indexOf(obj);
    if (i >= 0) {
      if (obj.held) { obj.held = false; this.c.held = null; this.c.magnetOn = false; }
      this.models.splice(i, 1); this.toast(`Removed ${obj.name}`, false); this.afterMove(null); return true;
    }
    if (this.c.removeObject(obj)) { this.afterMove(null); return true; }
    this.history.discardIfUnchanged(this);
    return false;
  }
  removeSelected() {
    if (!this.selectedObject) { this.toast("Nothing selected - click an object in the Scene list first", true); return false; }
    return this.removeObject(this.selectedObject);
  }
  clearObjects() {
    this.history.push(this, "Clear all objects");
    this.c.clearObjects();
    if (this.models.some((m) => m.held)) { this.c.held = null; this.c.magnetOn = false; }
    for (const m of this.models) m.held = false;
    this.models = [];
    this.selectedObject = null;
    this.toast("All objects removed", false);
    this.sceneChanged();
  }
  resetObjects() {
    this.history.push(this, "Reset cubes and disk");
    this.c.magnetOn = false;
    if (this.c.held) { this.c.held.body.held = false; this.c.held = null; }
    this.c.addDefaultObjects();
    if (this.selectedObject && !this.models.includes(this.selectedObject)) this.selectedObject = null;
    this.toast("Cubes and disk reset", false);
    this.sceneChanged();
  }
  applyPlatform(width, depth, record = true) {
    const lo = cfg.PLATFORM_MIN, hi = cfg.PLATFORM_MAX;
    const wanted = [Number(width), Number(depth)];
    if (record) this.history.push(this, "Platform size");
    const [moved, stuck] = this.c.setPlatform(width, depth);
    const p = this.c.platform;
    for (const m of this.models) {
      if (this.objectOnPlatform(m)) continue;
      const [hx, hy] = m.halfSize();
      const spot = p.clamp(m.offset[0], m.offset[1], hx, hy);
      if (!spot) stuck.push(m); else { m.offset[0] = spot[0]; m.offset[1] = spot[1]; moved.push(m); }
    }
    this.renderer.resetCamera();
    let msg = `Platform ${f0(p.width)} × ${f0(p.depth)} mm`;
    if (wanted[0] !== p.width || wanted[1] !== p.depth) msg += ` (limits ${lo}-${hi} mm)`;
    if (moved.length) msg += `. Moved ${moved.length} object${moved.length !== 1 ? "s" : ""} back onto it`;
    if (stuck.length) msg += `. ${stuck.length} too big to fit - marked off platform`;
    this.toast(msg, stuck.length > 0);
    this.sceneChanged();
    return [moved, stuck];
  }
  undoScene() {
    const before = this.c.platform.size.join();
    const label = this.history.undo(this);
    if (label === null) { this.toast("Nothing to undo", true); return false; }
    if (this.c.platform.size.join() !== before) this.renderer.resetCamera();
    this.toast(`Undo: ${label}`, false);
    this.sceneChanged();
    return true;
  }
  redoScene() {
    const before = this.c.platform.size.join();
    const label = this.history.redo(this);
    if (label === null) { this.toast("Nothing to redo", true); return false; }
    if (this.c.platform.size.join() !== before) this.renderer.resetCamera();
    this.toast(`Redo: ${label}`, false);
    this.sceneChanged();
    return true;
  }

  // ------------------------------------------------------------ scene files ---
  sceneToggles() {
    return { reach_map: this.showReach, reach_band: this.reach.showBand, reach_height: this.reach.height, path_trail: this.showPath,
      stop_on_collision_manual: this.stopOnCollision.manual, stop_on_collision_program: this.stopOnCollision.program,
      snap_to_surface: this.snapToSurface, block_overlaps: this.blockOverlaps };
  }
  sceneChanged(structural = true) {
    if (structural) this.sceneVersion = (this.sceneVersion || 0) + 1;
    this.syncPanel(true);
    if (!AUTOSAVE || this.restoring) return;
    clearTimeout(this._autosave);
    this._autosave = setTimeout(() => this.autosaveNow(), 400);
  }
  async autosaveNow() {
    try { localStorage.setItem(sio.AUTOSAVE_KEY, JSON.stringify(await sio.sceneToObject(this))); } catch (e) { console.warn("autosave failed", e); }
  }
  async sceneJSON() { return sio.sceneText(await sio.sceneToObject(this, { embed: true })); }
  async saveScene() {
    try {
      sio.download("my_scene.json", await this.sceneJSON());
      this.toast("Scene downloaded as my_scene.json", false);
    } catch (e) { this.toast(`Could not save the scene: ${e.message}`, true); }
  }
  async loadSceneFile(file, buf = null) {
    try {
      const text = buf ? new TextDecoder().decode(buf) : await file.text();
      return await this.applyScene(sio.parseScene(text), file.name);
    } catch (e) { this.toast(`Could not load scene ${file.name}: ${e.message}`, true); return false; }
  }
  async applyScene(d, label, { record = true, quiet = false } = {}) {
    const c = this.c;
    const models = [], missing = [];
    for (const m of d.models || []) {
      const name = m.name || m.file || m.stored || "model";
      const fname = String(m.file_name || m.stored || m.file || name).split(/[\\/]/).pop();
      let source = null;
      if (m.data) {
        const buf = fromBase64(m.data);
        try { source = { stored: await this.library.store(fname, buf) }; } catch { source = { data: buf }; }
      } else if (m.stored) source = { stored: m.stored };
      else if (m.file) {
        const bundled = this.library.bundled.find((b) => b.file === fname);
        if (bundled) source = { library: "models/" + bundled.file };
        else if (this.library.stored.find((s) => s.key === fname)) source = { stored: fname };
        else source = { library: "models/" + fname };
      }
      if (!source) { missing.push(name); continue; }
      try {
        const md = await this.library.load(source, fname, Number(m.scale || 1));
        md.offset = (m.pos || [200, 0, 0]).map(Number);
        md.rot = Array.isArray(m.rot) && m.rot.length === 3 ? m.rot.map(Number) : [0, 0, Number(m.yaw || 0)];
        if (m.magnetic !== undefined) md.magnetic = !!m.magnetic;
        md.color = (m.color || MODEL_COLORS[this.modelCount % MODEL_COLORS.length]).map(Number);
        md.name = m.name || fname;
        models.push(md);
        this.modelCount++;
      } catch { missing.push(fname); }
    }
    if (record) this.history.push(this, `Load ${label}`);
    const objs = (d.objects || []).map((o) => {
      const ob = new SceneObject(String(o.name ?? "Object"), o.kind || "cube", (o.pos || [150, 0, 0]).map(Number),
        { size: Number(o.size ?? 25), height: Number(o.height ?? 25), color: (o.color || [0.8, 0.2, 0.2]).map(Number) });
      if (Array.isArray(o.rot) && o.rot.length === 3) ob.rot = o.rot.map(Number);
      return ob;
    });
    if (c.magnetOn) c.setMagnet(false);
    if (c.held) { c.held.body.held = false; c.held = null; }
    const plat = d.platform || {};
    c.platform.resize(Number(plat.width ?? cfg.PLATFORM_SIZE[0]), Number(plat.depth ?? cfg.PLATFORM_SIZE[1]));
    c.objects = objs;
    this.models = models;
    if ((d.tool === "MAGNET" || d.tool === "PEN") && d.tool !== c.toolType) {
      if (quiet) this.setToolQuiet(d.tool); else this.setTool(d.tool);
    }
    const t = d.toggles || {};
    this.showReach = !!(t.reach_map ?? this.showReach);
    this.reach.showBand = !!(t.reach_band ?? this.reach.showBand);
    this.reach.height = Number(t.reach_height ?? this.reach.height);
    this.showPath = !!(t.path_trail ?? this.showPath);
    this.stopOnCollision.manual = t.stop_on_collision_manual ?? true;
    this.stopOnCollision.program = t.stop_on_collision_program ?? false;
    this.snapToSurface = t.snap_to_surface ?? true;
    this.blockOverlaps = t.block_overlaps ?? true;
    this.selectedObject = null;
    this.renderer.resetCamera();
    if (!quiet || missing.length) {
      let msg = `Loaded ${label}: ${objs.length} objects, ${models.length} models`;
      if (missing.length) msg += `. Missing model files: ${missing.slice(0, 3).join(", ")}`;
      this.toast(msg, missing.length > 0);
    }
    this.sceneChanged();
    return true;
  }
  setToolQuiet(tool) {
    const c = this.c, old = [c.toolType, c.penOffset];
    c.toolType = tool;
    if (tool === "PEN") c.penOffset = cfg.TYPICAL_PEN_OFFSET;
    if (kin.poseProblems(c.q, c.toolLength).length) [c.toolType, c.penOffset] = old;
  }
  async restoreScene() {
    if (!AUTOSAVE) return;
    let d = null;
    try { d = JSON.parse(localStorage.getItem(sio.AUTOSAVE_KEY) || "null"); } catch { d = null; }
    if (!d || d.format !== sio.FORMAT) return;
    this.restoring = true;
    try {
      await this.library.refresh();
      await this.applyScene(d, "autosave", { record: false, quiet: true });
    } catch (e) { console.warn("could not restore the autosaved scene", e); }
    this.restoring = false;
  }

  // ============================================================ program ===
  onEditorChange() {
    if (!this.editor) return;
    $("#ed-name").textContent = this.editor.name;
    $("#ed-mod").hidden = !this.editor.modified;
    $("#ed-tag").textContent = this.editor.fmt === "json" ? "VEXcode CTE" : "Python";
    clearTimeout(this._codeSave);
    this._codeSave = setTimeout(() => {
      try { localStorage.setItem(CODE_KEY, JSON.stringify({ text: this.editor.text, name: this.editor.name, fmt: this.editor.fmt, raw: this.editor.raw, modified: this.editor.modified })); } catch { /* full */ }
    }, 500);
    this.syncPanel(true);
  }
  restoreCode() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(CODE_KEY) || "null"); } catch { d = null; }
    if (d && typeof d.text === "string") {
      this.editor.open(d.text, { name: d.name || "untitled.ctepython", raw: d.raw || null, fmt: d.fmt || "json" });
      this.editor.modified = !!d.modified;
    } else this.editor.open(cte.NEW_PROJECT, { name: "untitled.ctepython" });
    this.onEditorChange();
  }
  toggleEditor(show = null) {
    this.showEditor = show === null ? !this.showEditor : show;
    $("#editor-pane").hidden = !this.showEditor;
    $("#btn-code").classList.toggle("active", this.showEditor);
    if (this.showEditor) setTimeout(() => this.editor.focus(), 0);
    this.resize();
  }
  async loadExamples() {
    try {
      const r = await fetch("examples/index.json", { cache: "no-cache" });
      this.examples = (await r.json()).examples || [];
    } catch { this.examples = []; }
    const sel = $("#examples");
    for (const e of this.examples) sel.append(h("option", { value: e.file }, e.name + (e.info ? `  (${e.info})` : "")));
  }
  async openExample(file, { run = true } = {}) {
    try {
      const r = await fetch("examples/" + encodeURIComponent(file));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return this.openProject(cte.decodeBytes(await r.arrayBuffer(), file), file, { run });
    } catch (e) { this.toast(`Can't load project: ${e.message}`, true); return false; }
  }
  async loadProjectFile(file, { run = true, buf = null } = {}) {
    try { return this.openProject(cte.decodeBytes(buf || await file.arrayBuffer(), file.name), file.name, { run }); }
    catch (e) { this.toast(`Can't load project: ${e.message}`, true); return false; }
  }
  openProject(text, name, { run = true } = {}) {
    if (this.host.running) { this.toast("Stop the running program first", true); return false; }
    let p;
    try { p = cte.parseProjectText(text, name); } catch (e) {
      this.host.state = "error"; this.host.status = `Can't load project: ${e.message}`;
      this.toast(this.host.status, true); this.syncPanel(true); return false;
    }
    this.editor.open(p.source, { name, raw: p.raw, fmt: p.fmt });
    this.c.target = null;
    if (run) { this.startProgram(p.source, name); this.toast(`Running ${name}`, false); }
    else this.toast(`Opened ${name} - press Run`, false);
    return true;
  }
  runEditorCode(startPaused = false) {
    if (this.host.running) { this.toast("A program is already running - Stop it first", true); return; }
    this.c.target = null;
    this.startProgram(this.editor.text, this.editor.name, startPaused);
    if (!startPaused) this.toast(`Running ${this.editor.name}${this.showEditor ? " from the editor" : ""}`, false);
  }
  startProgram(source, name, startPaused = false) {
    this.editor.setError(null);
    this.lastState = "starting";
    this.host.run(source, name, { startPaused });
    this.syncPython();
    this.syncPanel(true);
  }
  stopProgram() { if (this.host.running) { this.host.stop(); this.toast("Program stopped", false); } }
  togglePause() {
    if (!this.host.running) { this.toast("Pause works while a program runs", true); return; }
    if (this.host.paused) { this.host.resume(); this.toast("Resumed", false); }
    else { this.host.pause(); this.toast("Paused - Step runs one line, Resume carries on", false); }
    this.syncPanel(true);
  }
  stepProgram(kind = "line") {
    if (!this.host.running) {
      this.runEditorCode(true);
      this.toast("Paused at the first line - Step again to run it", false);
      return;
    }
    this.host.step(kind);
  }
  setSimSpeed(s) { this.host.setSpeed(s); this.toast(`Simulation speed ${s}×`, false); this.syncPanel(true); }
  changeSimSpeed(d) {
    const cur = this.host.timeScale;
    let i = SIM_SPEEDS.reduce((b, s, k) => (Math.abs(s - cur) < Math.abs(SIM_SPEEDS[b] - cur) ? k : b), 0);
    i = Math.max(0, Math.min(SIM_SPEEDS.length - 1, i + d));
    this.setSimSpeed(SIM_SPEEDS[i]);
  }
  newCode() {
    if (this.host.running) { this.toast("Stop the running program first", true); return; }
    this.editor.open(cte.NEW_PROJECT, { name: "untitled.ctepython" });
    this.toast("New CTE project in the editor (from cte import * ...)", false);
  }
  /** Text for Save: VEXcode JSON for VEXcode files, plain text for .py. -> [name, text] */
  saveData() {
    const ed = this.editor;
    let name = ed.name || "project.ctepython";
    if (ed.fmt === "json" || /\.(ctepython|exppython|v5python|iqpython)$/i.test(name)) {
      if (!/\.[a-z0-9]+python$/i.test(name)) name = name.replace(/\.[^.]*$/, "") + ".ctepython";
      return [name, cte.ctepythonText(ed.text, ed.raw)];
    }
    if (!/\.py$/i.test(name)) name = name.replace(/\.[^.]*$/, "") + ".py";
    return [name, ed.text];
  }
  exportData() {
    const ed = this.editor;
    return [(ed.name || "project").replace(/\.[^.]*$/, "") + ".ctepython", cte.ctepythonText(ed.text, ed.fmt === "json" ? ed.raw : null)];
  }
  saveCode() {
    const [name, text] = this.saveData();
    sio.download(name, text, "application/octet-stream");
    this.editor.modified = false;
    this.onEditorChange();
    this.toast(`Saved ${name}` + (name.toLowerCase().endsWith(".ctepython") ? "  (VEXcode .ctepython format)" : ""), false);
    return text;
  }
  exportCode() {
    const [name, text] = this.exportData();
    sio.download(name, text, "application/octet-stream");
    this.toast(`Exported ${name} - open it in VEXcode CTE`, false);
    return text;
  }

  onHost(kind) {
    if (kind === "state") {
      const st = this.host.state;
      if (st !== this.lastState) {
        if (st === "error") {
          this.toast(this.host.status, true);
          if (this.host.errorLine) this.editor.setError(this.host.errorLine);
        } else if (st === "finished") this.toast("Program finished");
        this.lastState = st;
      }
      if (!this.host.running) this.editor.setExec(null, false);
    }
    if (kind === "python" || kind === "state") this.syncPython();
    this.syncPanel(true);
  }
  syncPython() {
    const b = $("#py-banner");
    const hst = this.host;
    if (hst.pyStatus === "loading" && hst.running) {
      b.hidden = false;
      b.innerHTML = `<h3><span class="spin"></span>Loading Python…</h3><p>${esc(hst.pyMessage)}</p><p class="small muted">The first run downloads about 12 MB (after that the browser keeps a copy).</p>`;
    } else if (hst.pyStatus === "error" && !this.pyErrorClosed) {
      let host = "";
      try { host = new URL(PYODIDE_URL, document.baseURI).host; } catch { host = ""; }
      b.hidden = false;
      b.innerHTML = `<h3>Python could not load</h3>
        <p>The simulator downloads Python (Pyodide) from <b>${esc(host || "this site")}</b> and that did not work.</p>
        <p class="small">Common causes: no internet, or a school / company network that blocks that site. Ask IT to allow <b>cdn.jsdelivr.net</b>,
        or host Python next to the simulator (README: "Self-hosting Python"). The arm, joints and scene still work.</p>
        <p class="small muted">Details: ${esc(hst.pyMessage)}</p>
        <div class="row"><span class="spacer"></span><button id="py-dismiss">Close</button><button class="primary" id="py-retry">Try again</button></div>`;
      $("#py-dismiss").onclick = () => { this.pyErrorClosed = true; b.hidden = true; };
      $("#py-retry").onclick = () => { b.hidden = true; this.host.pyStatus = "off"; this.runEditorCode(); };
    } else b.hidden = true;
    if (hst.pyStatus !== "error") this.pyErrorClosed = false;
  }

  // ========================================================= collisions ===
  /** What the arm can bump into: cubes / disks as boxes, imported models with their real mesh. */
  collisionBodies() {
    const items = [];
    for (const b of this.c.bodies()) {
      if (b.held) continue;
      const [lo, hi] = bodies.aabb(b);
      items.push({ name: b.name, lo, hi, body: b });
    }
    return items;
  }
  collisionBoxes() { return this.collisionBodies(); }
  /** Collision warnings: red links + a toast. Manual moves stop before a
   * collision; programs only warn unless "Stop on collision: Programs" is on. */
  checkCollisions() {
    const c = this.c;
    const q = [...c.q];
    const fk = c.fk(q);
    let hits = collision.armObjectHits(fk, c.toolType, this.collisionBodies());
    let selfh = collision.armSelfHits(fk, c.toolType);
    const key = (x) => x.join("|");
    let now = new Set([...hits.map(key), ...selfh.map(key)]);
    const program = this.host.running;
    if (!q.every((v, i) => Math.abs(v - this.qSafe[i]) < 1e-8)) {
      const fresh = [...now].filter((k) => !this.safeHits.has(k));
      if (fresh.length && !program && this.stopOnCollision.manual) {
        c.stop();
        c.q = [...this.qSafe];
        c.updateHeld();
        this.toast("Stopped before a collision: " + collision.describe(hits.filter((x) => fresh.includes(key(x))), selfh.filter((x) => fresh.includes(key(x)))), true);
        hits = hits.filter((x) => this.safeHits.has(key(x)));
        selfh = selfh.filter((x) => this.safeHits.has(key(x)));
        now = new Set([...hits.map(key), ...selfh.map(key)]);
      } else { this.qSafe = q; this.safeHits = now; }
    } else this.safeHits = now;
    const fresh = [...now].filter((k) => !this.prevHits.has(k));
    if (fresh.length) {
      const msg = collision.describe(hits.filter((x) => fresh.includes(key(x))), selfh.filter((x) => fresh.includes(key(x))));
      if (msg) {
        if (program && this.stopOnCollision.program) { c.stop(); this.host.stop(); this.toast("Program stopped - collision: " + msg, true); }
        else this.toast("Collision: " + msg, true);
      }
    }
    this.prevHits = now;
    this.hits = hits; this.selfHits = selfh;
  }

  // ============================================================== frame ===
  loop(t) {
    const dt = Math.min(0.1, Math.max(0, (t - this.last) / 1000));
    this.last = t;
    try { this.update(dt); this.draw(); } catch (e) { console.error(e); }
    this.frames++;
    requestAnimationFrame((tt) => this.loop(tt));
  }

  update(dt) {
    this.handleHeldKeys(dt);
    const host = this.host;
    if (!(host.running && host.paused)) {
      const scale = host.timeScale;
      const n = Math.max(1, Math.ceil(scale));
      for (let i = 0; i < n; i++) {                       // small sub-steps keep fast motion smooth
        this.c.step(dt * scale / n);
        if (n > 1) this.sampleTrails();                    // so pen corners are not cut at high sim speed
      }
      host.update(dt * scale);
    }
    this.checkCollisions();
    this.sampleTrails();
    if (this.showReach) this.reach.request(this.c.platform.bounds(), this.c.toolLength);
    if (host.running) this.editor.setExec(host.currentLine, host.paused);
  }

  sampleTrails() {
    const tip = this.c.position();
    const lp = this.pathTrail.at(-1);
    if (!lp || kin.norm(kin.sub(tip, lp)) > 1.5) {
      this.pathTrail.push(tip);
      if (this.pathTrail.length > PATH_TRAIL_MAX) this.pathTrail.shift();
      this.pathVersion++;
    }
    if (this.c.toolType === "PEN") {
      const last = this.trail.at(-1);
      if (tip[2] <= 2.0) {
        if (!last || kin.norm(kin.sub(tip, last)) > 0.4) { this.trail.push(tip); this.trailVersion++; }
      } else if (last) { this.trail.push(null); this.trailVersion++; }
    }
  }

  jointColors() {
    const lim = kin.jointsAtLimit(this.c.q);
    return lim.map((l, i) => (l ? C_LIMIT : i === this.selected ? C_SELECTED : C_HOUSING));
  }

  draw() {
    const r = this.renderer, c = this.c;
    const fk = c.fk();
    r.buildFloor();
    const hitLinks = new Set([...this.hits.map((x) => x[0]), ...this.selfHits.flat()]);
    const hitObjs = new Set(this.hits.map((x) => x[1]));
    if (this.selectedObject && !c.objects.includes(this.selectedObject) && !this.models.includes(this.selectedObject)) this.selectedObject = null;
    r.drawArm(fk, this.jointColors(), c.toolType, c.magnetOn, hitLinks);
    r.syncObjects(c.objects, this.selectedObject);
    r.syncModels(this.models, this.selectedObject);
    r.setTrail(this.trail, this.trailVersion);
    r.setPath(this.pathTrail, this.showPath, this.pathVersion);
    r.setReach(this.reach, this.showReach);
    r.setTarget(c.target, c.targetReachable);
    const hitItem = this.sceneItems().find((it) => hitObjs.has(it.name));
    if (hitItem) r.setSelection(...this.objectBounds(hitItem.obj), [0.9, 0.15, 0.15]);
    else if (this.selectedObject) r.setSelection(...this.objectBounds(this.selectedObject), [0.15, 0.4, 0.92]);
    else r.setSelection(null);
    if (this.placeMode && this.mouseFloor) {
      const [hx, hy, hh] = this.placeHalfNow();
      const [x, y] = this.mouseFloor;
      r.setGhost({ x, y, hx, hy, h: hh, ok: c.platform.contains(x, y, hx, hy) });
    } else r.setGhost(null);
    if (this.selectedObject && !this.selectedObject.held && !this.placeMode) r.setGizmo(this.gizmoCenter(this.selectedObject), this.drag?.ring || this.drag?.axis || this.hoverAxis || null, this.gizmoMode);
    else r.setGizmo(null);
    r.render();
    this.drawLabels();
    this.syncPanel();
  }

  drawLabels() {
    const box = $("#labels");
    if (!this.labelEls) {
      this.labelEls = [["X", [135, 0, 0], "#c81e1e"], ["Y", [0, 135, 0], "#1e8c28"], ["Z", [0, 0, 135], "#1e46dc"]].map(([t, p, col]) => {
        const e = h("div", { class: "axis", style: `color:${col};left:0;top:0` }, t); box.append(e); return [e, p];
      });
      this.targetLabel = h("div", { class: "tlabel", style: "left:0;top:0", hidden: true });
      box.append(this.targetLabel);
    }
    for (const [e, p] of this.labelEls) {
      const sp = this.renderer.project(p);
      e.hidden = !sp;
      if (sp) e.style.transform = `translate(${sp[0]}px, ${sp[1]}px) translate(-50%, -50%)`;
    }
    const t = this.c.target, tl = this.targetLabel;
    const sp = t && this.renderer.project(t);
    if (sp && sp[0] < this.renderer.w - 40) {
      const ok = this.c.targetReachable;
      const s = `${f0(t[0])}, ${f0(t[1])}, ${f0(t[2])}` + (ok ? "" : "  ·  out of reach");
      if (tl.textContent !== s) tl.textContent = s;
      tl.style.color = tl.style.borderColor = ok ? "#16a34a" : "#dc2626";
      tl.style.transform = `translate(${sp[0] + 12}px, ${sp[1] - 30}px)`;
      tl.hidden = false;
    } else tl.hidden = true;
  }

  // ======================================================== panel sync ===
  syncPanel(force = false) {
    const now = performance.now();
    if (!this.jointEls || (!force && now - (this._lastSync || 0) < 50)) return;
    this._lastSync = now;
    const c = this.c, host = this.host;
    let [stl, stc] = STATUS_STYLE[host.state] || STATUS_STYLE.idle;
    if (host.running && host.paused) [stl, stc] = ["Paused", "#d97706"];
    let tool = c.toolType === "MAGNET" ? "Magnet" : "Pen";
    if (c.toolType === "MAGNET") tool += c.magnetOn ? " on" : " off";
    const chips = [`<div class="chip"><i style="background:${stc}"></i><b>${stl}</b></div>`];
    if (host.timeScale !== 1) chips.push(`<div class="chip"><span>Sim</span><b>${host.timeScale}×</b></div>`);
    chips.push(`<div class="chip"><span>Tool</span><b>${tool}</b></div>`, `<div class="chip"><span>Speed</span><b>${c.speedPercent}%</b></div>`);
    this.setHTML("#chips", chips.join(""));
    // readout
    const fk = c.fk(), pos = fk.position, ypr = kin.matrixToYpr(fk.rotation);
    const moving = !c.isDone();
    const cell = (l, v, u) => `<div class="cell"><span>${l}</span><b>${f1(v)}</b><i>${u}</i></div>`;
    const reach = kin.norm(kin.sub(pos, fk.points().shoulder));
    this.setHTML("#readout", `<div class="hd"><span class="lbl">Tool position</span><span class="tag${moving ? " moving" : ""}">${moving ? "Moving" : "Idle"}</span></div>
      <div class="grid">${cell("X", pos[0], "mm")}${cell("Y", pos[1], "mm")}${cell("Z", pos[2], "mm")}${cell("Yaw", ypr[0], "°")}${cell("Roll", ypr[1], "°")}${cell("Pitch", ypr[2], "°")}</div>
      <div class="reach">Reach ${f0(reach)} of ${f0(cfg.MAX_REACH)} mm from the shoulder</div>`);
    // joints
    const lim = kin.jointsAtLimit(c.q);
    this.jointEls.forEach((el, i) => {
      const [lo, hi] = kin.LIMITS[i];
      const q = c.q[i];
      el.classList.toggle("sel", i === this.selected);
      el.classList.toggle("lim", lim[i]);
      $(".jr", el).hidden = !(i === this.selected && !lim[i]);
      $(".pill-lim", el).hidden = !lim[i];
      const vt = `${f1(q)}°`;
      const jv = $(".jv", el);
      if (jv.textContent !== vt) jv.textContent = vt;
      const z = (0 - lo) / (hi - lo) * 100, k = (q - lo) / (hi - lo) * 100;
      $(".fill", el).style.cssText = `left:${Math.min(z, k)}%;width:${Math.abs(k - z)}%`;
      $(".knob", el).style.left = `${k}%`;
      $(".slider", el).setAttribute("aria-valuenow", f1(q));
    });
    const cl = $("#cur-line");
    cl.hidden = !host.running;
    if (host.running) {
      const line = host.currentLine;
      const src = host.lineText(line);
      let lab, col, tail = "";
      if (host.paused) { lab = line ? `Line ${line}` : "Starting"; col = "#d97706"; tail = ` · ${host.pausedAt === "command" ? "next arm command" : "paused"}`; }
      else { lab = line ? `Line ${line}` : (host.pyStatus === "ready" ? "Running" : "Loading Python…"); col = "#16a34a"; }
      this.setHTML("#cur-line", `<b style="color:${col}">${lab}</b><span class="muted">${esc(tail)}</span>&nbsp; <code>${esc(src)}</code>`);
    }
    if (!force) return;
    // tool
    $$("#tool-seg button").forEach((b) => b.classList.toggle("on", b.dataset.arg === c.toolType));
    const mag = c.toolType === "MAGNET";
    const mb = $("#btn-magnet");
    mb.textContent = mag ? (c.magnetOn ? "Magnet on" : "Magnet off") : "Magnet (n/a)";
    mb.disabled = !mag; mb.classList.toggle("active", mag && c.magnetOn);
    $("#speed-val").textContent = `${c.speedPercent}%`;
    $("#speed-fill").style.width = `${c.speedPercent}%`;
    $("#tool-head").textContent = this.collapsed.tool ? `${tool} · ${c.speedPercent}%` : "";
    const drawing = this.hasDrawing(), ns = this.strokes();
    $("#pen-info").textContent = drawing ? `${ns} stroke${ns !== 1 ? "s" : ""}` : "none";
    $("#btn-clear-drawing").disabled = !drawing;
    // platform
    const p = c.platform;
    $("#plat-head").textContent = `${f0(p.width)} × ${f0(p.depth)} mm`;
    for (const [id, v] of [["plat-w", p.width], ["plat-d", p.depth]]) { const inp = $("#" + id); if (document.activeElement !== inp) inp.value = f0(v); }
    $$("#presets button").forEach((b) => {
      if (b.dataset.action === "platform_preset") { const [w, d] = b.dataset.arg.split(",").map(Number); b.classList.toggle("active", w === p.width && d === p.depth); }
      else b.disabled = p.width === cfg.PLATFORM_SIZE[0] && p.depth === cfg.PLATFORM_SIZE[1];
    });
    // scene list
    const items = this.sceneItems();
    $("#scene-title").textContent = `Scene objects · ${items.length}`;
    $("#btn-clear-all").disabled = !items.length;
    $("#btn-place").classList.toggle("active", this.placeMode);
    const list = $("#scene-list");
    const sig = JSON.stringify(items.map((it) => [it.name, it.type, it.pos.map((v) => Math.round(v)), it.held, this.objectOnPlatform(it.obj), it.obj === this.selectedObject, it.color, it.obj.magnetic]));
    if (sig !== this._sceneSig) {
      this._sceneSig = sig;
      list.innerHTML = "";
      if (!items.length) list.append(h("div", { class: "empty" }, "Empty. Press N for the cubes, or Add model"));
      for (const it of items) {
        const off = !it.held && !this.objectOnPlatform(it.obj);
        const sel = it.obj === this.selectedObject;
        const isModel = bodies.isModel(it.obj);
        list.append(h("div", { class: "obj" + (sel ? " sel" : ""), role: "option", "aria-selected": String(sel), title: it.name, "data-name": it.name,
          onclick: (ev) => { if (ev.target.closest(".x, .mag")) return; this.selectedObject = sel ? null : it.obj; this.syncPanel(true); } },
        h("span", { class: "sw", style: `background:${css(it.color)}` }), h("span", { class: "nm" }, it.name), h("span", { class: "ty" }, it.type),
        it.held || off ? h("span", { class: "st " + (it.held ? "held" : "off") }, it.held ? "held" : "off platform")
          : h("span", { class: "ps" }, `${f0(it.pos[0])}, ${f0(it.pos[1])}, ${f0(it.pos[2])}`),
        isModel ? h("input", { type: "checkbox", class: "mag", title: `Magnetic - the magnet can pick ${it.name} up`, "aria-label": `${it.name} magnetic`,
          checked: it.obj.magnetic !== false, onchange: (ev) => this.setMagnetic(it.obj, ev.target.checked) }) : null,
        h("button", { class: "x", title: `Remove ${it.name}`, "aria-label": `Remove ${it.name}`, onclick: () => { this.removeObject(it.obj); } }, "✕")));
      }
    }
    this.syncSelection();
    // overlays
    $("#ov-head").textContent = [this.showReach && "Reach", this.showPath && "Trail"].filter(Boolean).join(" · ");
    $("#sw-reach").classList.toggle("on", this.showReach);
    $("#sw-reach").setAttribute("aria-checked", String(this.showReach));
    $("#reach-busy").hidden = !(this.showReach && this.reach.busy);
    const bandOn = this.showReach && this.reach.showBand;
    $("#sw-band").classList.toggle("on", bandOn);
    $("#sw-band").disabled = !this.showReach;
    $("#band-minus").disabled = $("#band-plus").disabled = !bandOn;
    $("#band-val").textContent = `${f0(this.reach.height)} mm`;
    $("#band-label").classList.toggle("muted", !this.showReach);
    $("#sw-path").classList.toggle("on", this.showPath);
    $("#sw-path").setAttribute("aria-checked", String(this.showPath));
    $("#btn-path-clear").disabled = this.pathTrail.length <= 1;
    $("#cs-manual").classList.toggle("active", this.stopOnCollision.manual);
    $("#cs-program").classList.toggle("active", this.stopOnCollision.program);
    // program
    $("#prog-name").textContent = host.projectName || this.editor?.name || "No project loaded";
    this.setHTML("#prog-pill", `<i style="background:${stc}"></i><span>${stl}</span>`);
    const err = $("#prog-error");
    err.hidden = host.state !== "error";
    err.textContent = host.state === "error" ? host.status : "";
    $("#btn-run").disabled = host.running;
    $("#btn-stop").disabled = !host.running;
    const pb = $("#btn-pause");
    pb.textContent = host.running && host.paused ? "Resume" : "Pause";
    pb.disabled = !host.running;
    pb.classList.toggle("active", host.running && host.paused);
    $$("#sim-seg button").forEach((b) => b.classList.toggle("on", Number(b.dataset.arg) === host.timeScale));
    const blink = Math.floor(now / 333) % 2 === 0;
    $$("#tower i").forEach((i) => { const st = host.tower[i.dataset.c]; i.classList.toggle("lit", st === "ON" || (st === "BLINK" && blink)); });
    // brain screen
    const scr = host.screen;
    const rows = scr.visible(200).map((r) => r.replace(/\s+$/, ""));
    while (rows.length && !rows.at(-1)) rows.pop();
    const printed = rows.filter((r) => r.trim()).length;
    $("#brain-head").textContent = `${printed} line${printed !== 1 ? "s" : ""}`;
    const notes = scr.notes.slice(-2);
    const csig = scr.version + "|" + scr.notes.length + "|" + notes.join("|");
    if (csig !== this._consoleSig) {
      this._consoleSig = csig;
      const con = $("#console");
      con.innerHTML = (rows.length ? esc(rows.join("\n")) : `<span class="ph">(nothing printed yet)</span>`) +
        (notes.length ? "<hr>" + notes.map((n) => `<span class="${n.startsWith("ERROR") ? "ne" : "nt"}">${esc(n)}</span>`).join("\n") : "");
      con.scrollTop = con.scrollHeight;
    }
    const chip = $("#mode-chip");
    chip.hidden = !this.placeMode;
    if (this.placeMode) chip.textContent = `Place mode · ${this.itemLabel(this.placeItem)} · click the platform · Esc to stop`;
    $("#toasts").classList.toggle("below-chip", this.placeMode);
  }
  /** The position editor under the scene list. */
  syncSelection() {
    const b = this.selectedObject, panel = $("#sel-panel");
    panel.hidden = !b;
    if (!b) return;
    const isModel = bodies.isModel(b), o = bodies.origin(b);
    $("#sel-name").textContent = b.name + (b.held ? " · held by the magnet" : "");
    $("#sel-mag-row").hidden = !isModel;
    if (isModel) $("#sel-magnetic").checked = b.magnetic !== false;
    for (const [id, v] of [["sel-x", o[0]], ["sel-y", o[1]], ["sel-z", o[2]]]) {
      const inp = $("#" + id);
      if (document.activeElement !== inp) inp.value = f1(v).replace(/\.0$/, "");
      inp.disabled = !!b.held;
    }
    const r = bodies.rot(b);
    for (const [id, v] of [["sel-rx", r[0]], ["sel-ry", r[1]], ["sel-rz", r[2]]]) {
      const inp = $("#" + id);
      if (document.activeElement !== inp) inp.value = f1(v).replace(/\.0$/, "");
      inp.disabled = !!b.held;
    }
    $("#btn-drop").disabled = !!b.held || bodies.bottomZ(b) < 0.01;
    $("#btn-lay-flat").disabled = !!b.held || (Math.abs(r[0]) < 1e-9 && Math.abs(r[1]) < 1e-9);
    $("#btn-reset-rot").disabled = !!b.held || !bodies.isRotated(b);
    $$("#sel-panel .sq[data-action=nudge], #sel-panel .sq[data-action=rotate_axis]").forEach((el) => { el.disabled = !!b.held; });
    $$("#step-seg button").forEach((el) => el.classList.toggle("on", Number(el.dataset.arg) === this.moveStep));
    $$("#rot-step-seg button").forEach((el) => el.classList.toggle("on", Number(el.dataset.arg) === this.rotStep));
    $$("#mode-seg button").forEach((el) => el.classList.toggle("on", el.dataset.arg === this.gizmoMode));
    $("#sw-snap").classList.toggle("on", this.snapToSurface); $("#sw-snap").setAttribute("aria-checked", String(this.snapToSurface));
    $("#sw-block").classList.toggle("on", this.blockOverlaps); $("#sw-block").setAttribute("aria-checked", String(this.blockOverlaps));
  }
  setHTML(sel, html) { const el = $(sel); if (el._html !== html) { el.innerHTML = html; el._html = html; } }
}

const app = new App();
setInterval(() => app.syncPanel(true), 250);      // tower blink, status pill, console
window.app = app;
export default app;
