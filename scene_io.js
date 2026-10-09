// scene_io.js - scene files, autosave and scene undo/redo (port of v4 scene_io.py).
//
// A scene file is JSON (same layout as v4, plus "stored"/"data" for models
// imported in the browser):
//   {"format": "six-axis-arm-scene", "version": 1,
//    "platform": {"width": 638, "depth": 333}, "tool": "MAGNET", "pen_offset": 0,
//    "toggles": {...},
//    "objects": [{"name": "Red cube", "kind": "cube", "pos": [160, -90, 0], "size": 25, "height": 25, "color": [...]}],
//    "models":  [{"name": "test_pallet.3mf", "file": "models/test_pallet.3mf", "scale": 1, "pos": [300, 100, 0], "color": [...]},
//                {"name": "bracket.stl", "stored": "bracket.stl", "data": "<base64, so the file works on another computer>", ...}]}
// Undo keeps snapshots of the objects (by identity, so a removed object comes
// back as the very same object), the models and the platform size.

export const FORMAT = "six-axis-arm-scene";
export const AUTOSAVE_KEY = "six-axis-arm.scene.v1";
export const EMBED_LIMIT = 8 * 1024 * 1024;     // embed imported models up to 8 MB in downloaded scenes

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

// ------------------------------------------------------------------ undo ---
export function snapshot(app) {
  const c = app.c;
  return {
    objects: c.objects.map((ob) => [ob, [...ob.pos]]),
    models: app.models.map((m) => [m, [...m.offset]]),
    platform: [c.platform.width, c.platform.depth],
  };
}

export function restore(app, snap) {
  const c = app.c;
  const held = c.objects.filter((ob) => ob.held);
  const objs = [];
  for (const [ob, pos] of snap.objects) {
    if (!ob.held) ob.pos = [...pos];
    objs.push(ob);
  }
  for (const ob of held) if (!objs.includes(ob)) objs.push(ob);
  c.objects = objs;
  c.platform.resize(...snap.platform);
  app.models = snap.models.map(([m, off]) => { m.offset = [...off]; return m; });
  if (app.selectedObject && !objs.includes(app.selectedObject) && !app.models.includes(app.selectedObject)) app.selectedObject = null;
}

const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
function same(a, b) {
  if (a.platform[0] !== b.platform[0] || a.platform[1] !== b.platform[1]) return false;
  if (a.objects.length !== b.objects.length || a.models.length !== b.models.length) return false;
  for (let i = 0; i < a.objects.length; i++) if (a.objects[i][0] !== b.objects[i][0] || !close(a.objects[i][1], b.objects[i][1])) return false;
  for (let i = 0; i < a.models.length; i++) if (a.models[i][0] !== b.models[i][0] || !close(a.models[i][1], b.models[i][1])) return false;
  return true;
}

export class SceneHistory {
  constructor() { this.undoStack = []; this.redoStack = []; this.limit = 100; }
  /** Call BEFORE changing the scene. */
  push(app, label) {
    const snap = snapshot(app);
    const top = this.undoStack.at(-1);
    if (top && top[0] === label && same(top[1], snap)) return;
    this.undoStack.push([label, snap]);
    if (this.undoStack.length > this.limit) this.undoStack.splice(0, this.undoStack.length - this.limit);
    this.redoStack = [];
  }
  discardIfUnchanged(app) {
    const top = this.undoStack.at(-1);
    if (top && same(top[1], snapshot(app))) this.undoStack.pop();
  }
  undo(app) {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push([e[0], snapshot(app)]);
    restore(app, e[1]);
    return e[0];
  }
  redo(app) {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push([e[0], snapshot(app)]);
    restore(app, e[1]);
    return e[0];
  }
}

// ----------------------------------------------------------------- files ---
/** Scene -> plain object. embed: base64 of imported models (for downloads). */
export async function sceneToObject(app, { embed = false } = {}) {
  const c = app.c;
  const models = [];
  for (const m of app.models) {
    const d = { name: m.name, scale: m.userScale, pos: m.offset.map(r2), color: m.color.slice(0, 3).map(r3) };
    if (m.source.library) d.file = m.source.library;
    else if (m.source.stored) d.stored = m.source.stored;
    if (embed && !m.source.library) {
      try {
        const buf = await app.library.bytes(m.source);
        if (buf && buf.byteLength <= EMBED_LIMIT) { d.data = app.toBase64(buf); d.file_name = m.source.stored || m.name; }
      } catch { /* leave it out */ }
    }
    models.push(d);
  }
  return {
    format: FORMAT, version: 1,
    platform: { width: c.platform.width, depth: c.platform.depth },
    tool: c.toolType, pen_offset: c.penOffset,
    toggles: app.sceneToggles(),
    objects: c.objects.map((ob) => ({ name: ob.name, kind: ob.kind, pos: ob.pos.map(r2), size: ob.size, height: ob.height, color: ob.color.slice(0, 3).map(r3) })),
    models,
  };
}

/** Pretty JSON like v4 (short number lists stay on one line). */
export function sceneText(obj) {
  return JSON.stringify(obj, null, 2).replace(/\[\s*(-?[0-9.eE+-]+(?:,\s*-?[0-9.eE+-]+)*)\s*\]/g,
    (_, inner) => "[" + inner.split(",").map((v) => v.trim()).join(", ") + "]") + "\n";
}

export function parseScene(text) {
  const d = JSON.parse(text);
  if (!d || typeof d !== "object" || d.format !== FORMAT) throw new Error("not a six-axis-arm scene file");
  return d;
}

export function download(filename, text, type = "application/json") {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
