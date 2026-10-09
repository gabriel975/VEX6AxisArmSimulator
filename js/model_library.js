// model_library.js - 3D models (STL / 3MF) for the scene.
//  * Bundled models: listed in models/index.json (files in models/).
//  * Imported models: the file the student picks is kept in the browser's
//    IndexedDB, so it is still there next time (like v4 copying into models/).
// Parsing is in file_formats.js (binary / ASCII STL, 3MF incl. the production
// extension); the result is one triangle soup in mm, centred on (0, 0) with its
// lowest point at z = 0 (v4 place_on_floor).
import { parseModelBytes, extOf, MODEL_EXTS } from "./file_formats.js";
import * as bodies from "./bodies.js";

export { MODEL_EXTS };
export const MAX_SIZE = 400;          // mm - bigger models are scaled down (v4)
export const TINY_SIZE = 1.5;         // mm - smaller models were probably saved in meters: scaled up x1000
export const PALETTE = [[0.2, 0.72, 0.75], [0.95, 0.6, 0.15], [0.6, 0.4, 0.85], [0.4, 0.7, 0.3]];

const ext = extOf;

/** ArrayBuffer of an .stl / .3mf -> Float32Array of triangle vertices (mm). */
export function parseModel(buffer, name) {
  const r = parseModelBytes(buffer, name);
  if (!r.positions.length) throw new Error("the file has no triangles");
  return r.positions;
}

function boundsOf(p) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) { const v = p[i + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
  }
  return [lo, hi];
}

let nextId = 1;
/** A model placed in the scene (v4 models.Mesh + its offset). */
export class ModelItem {
  constructor(name, fmt, positions, source, scale = 1, notes = []) {
    this.id = "m" + nextId++;
    this.name = name;
    this.fmt = fmt;
    this.source = source;            // {library: "models/x.stl"} | {stored: key}
    this.userScale = scale;
    this.positions = positions;
    this.color = PALETTE[0];
    this.offset = [0, 0, 0];         // world position of the local origin (bottom centre), mm
    this.yaw = 0;                    // rotation about Z, degrees
    this.magnetic = true;            // the magnet can pick it up
    this.held = false;               // currently carried by the magnet
    this.autoScale = 1;              // what placeOnFloor did on top of userScale
    this.notes = [...notes];         // human readable: unit conversions, auto scaling
    this.placeOnFloor();
  }
  placeOnFloor() {
    const p = this.positions;
    if (this.userScale !== 1) for (let i = 0; i < p.length; i++) p[i] *= this.userScale;
    let [lo, hi] = boundsOf(p);
    const size = () => Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    let biggest = size();
    if (!(biggest > 0)) throw new Error("the model has no size (all points are the same)");
    if (biggest < TINY_SIZE) {                       // a 25 mm cube saved in meters is 0.025 "mm" across
      const k = 1000;
      for (let i = 0; i < p.length; i++) p[i] *= k;
      [lo, hi] = boundsOf(p);
      this.autoScale *= k;
      this.notes.push(`scaled x1000 - the file looked like meters (it was ${biggest < 0.01 ? biggest.toExponential(1) : +biggest.toFixed(3)} mm across)`);
      biggest = size();
    }
    if (biggest > MAX_SIZE) {
      const k = MAX_SIZE / biggest;
      for (let i = 0; i < p.length; i++) p[i] *= k;
      [lo, hi] = boundsOf(p);
      this.autoScale *= k;
      this.notes.push(`scaled down to ${MAX_SIZE} mm - the file was ${Math.round(biggest)} mm across`);
    }
    const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, cz = lo[2];
    for (let i = 0; i < p.length; i += 3) { p[i] -= cx; p[i + 1] -= cy; p[i + 2] -= cz; }
    [this.lo, this.hi] = boundsOf(p);
  }
  bounds() { return [this.lo, this.hi]; }
  size() { return [0, 1, 2].map((k) => this.hi[k] - this.lo[k]); }
  halfSize() { return bodies.halfSize(this); }
  worldBounds() { return bodies.aabb(this); }
  top() { return bodies.topZ(this); }
}

// -------------------------------------------------------------- storage ---
const DB_NAME = "six-axis-arm", STORE = "models";
function openDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in self)) { reject(new Error("this browser has no IndexedDB")); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const st = t.objectStore(STORE);
    const req = fn(st);
    t.oncomplete = () => { resolve(req ? req.result : undefined); db.close(); };
    t.onerror = () => { reject(t.error); db.close(); };
  });
}

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

export class ModelLibrary {
  constructor(baseUrl = "models/") { this.baseUrl = baseUrl; this.bundled = []; this.stored = []; this._cache = new Map(); }

  async refresh() {
    try {
      const r = await fetch(this.baseUrl + "index.json", { cache: "no-cache" });
      this.bundled = r.ok ? (await r.json()).models || [] : [];
    } catch { this.bundled = []; }
    try {
      this.stored = (await tx("readonly", (st) => st.getAll())).map(({ key, name, fmt, size, added, magnetic }) => ({ key, name, fmt, size, added, magnetic: magnetic !== false }));
      this.stored.sort((a, b) => a.name.localeCompare(b.name));
    } catch { this.stored = []; }
    return this;
  }

  /** Keep an imported file in IndexedDB (same name + same bytes -> reuse). -> key */
  async store(name, buffer) {
    const stem = name.replace(/\.[^.]+$/, ""), e = ext(name);
    let key = name, n = 2;
    for (;;) {
      const old = await tx("readonly", (st) => st.get(key));
      if (!old) break;
      if (sameBytes(old.data, buffer)) return key;
      key = `${stem}_${n++}${e}`;
    }
    await tx("readwrite", (st) => st.put({ key, name: key, fmt: e.slice(1).toUpperCase(), size: buffer.byteLength, added: Date.now(), data: buffer, magnetic: true }));
    return key;
  }
  async removeStored(key) { await tx("readwrite", (st) => st.delete(key)); }
  /** Remember whether the magnet can pick up a stored model (used as the default when it is added again). */
  async setStoredMagnetic(key, on) {
    const rec = await tx("readonly", (st) => st.get(key));
    if (!rec) return false;
    rec.magnetic = !!on;
    await tx("readwrite", (st) => st.put(rec));
    const s = this.stored.find((x) => x.key === key);
    if (s) s.magnetic = !!on;
    return true;
  }
  /** Default "magnetic" flag for a source: stored record, models/index.json entry, else true. */
  defaultMagnetic(source) {
    if (source.stored) { const s = this.stored.find((x) => x.key === source.stored); return s ? s.magnetic !== false : true; }
    if (source.library) { const b = this.bundled.find((x) => "models/" + x.file === source.library); return b ? b.magnetic !== false : true; }
    return true;
  }
  async getStored(key) { const r = await tx("readonly", (st) => st.get(key)); return r ? r.data : null; }

  /** Bytes of a bundled file (models/x.stl) or a stored one. */
  async bytes(source) {
    const k = JSON.stringify(source);
    if (this._cache.has(k)) return this._cache.get(k);
    let buf = null;
    if (source.library) {
      const r = await fetch(source.library);
      if (!r.ok) throw new Error(`${source.library} not found (HTTP ${r.status})`);
      buf = await r.arrayBuffer();
    } else if (source.stored) {
      buf = await this.getStored(source.stored);
      if (!buf) throw new Error(`${source.stored} is not in this browser's model library`);
    } else if (source.data) {
      buf = source.data;
    }
    this._cache.set(k, buf);
    return buf;
  }

  /** Load a model ready to place (not added to the scene). */
  async load(source, name, scale = 1) {
    const buf = await this.bytes(source);
    const r = parseModelBytes(buf, name);
    if (!r.positions.length) throw new Error("the file has no triangles");
    const m = new ModelItem(name, ext(name).slice(1).toUpperCase() || r.fmt, r.positions, source, scale, r.notes);
    m.magnetic = this.defaultMagnetic(source);
    return m;
  }
}

export function toBase64(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(str) {
  const s = atob(str), b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b.buffer;
}
