// file_formats.js - what kind of file did the user give us, and how to read the
// 3D model formats. Pure JavaScript (no DOM, no three.js) so it also runs under
// node --test.
//
//   detectFileKind(name, bytes) -> "model" | "scene" | "program" | null
//   parseSTL(bytes)             -> Float32Array of triangle vertices
//   parse3MF(bytes)             -> { positions, unit, unitScale, items, parts }
//
// The 3MF reader handles the plain core spec (one 3D/3dmodel.model) as well as
// the production extension used by Bambu Studio / Orca / PrusaSlicer: objects
// spread over 3D/Objects/*.model parts, referenced by p:path from components or
// build items, with object ids that are only unique inside their own part.
import * as fflate from "../vendor/three/addons/fflate.module.js";
import { PROJECT_EXTS } from "./ctefile.js";
import { FORMAT as SCENE_FORMAT } from "./scene_io.js";

export const MODEL_EXTS = [".stl", ".3mf"];
export const SCENE_EXTS = [".json"];
export { PROJECT_EXTS };
export const SUPPORTED_SUMMARY = "models (.stl, .3mf), scenes (.json) and programs (.ctepython, .py)";
export const UNITS_TO_MM = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

export const extOf = (name) => (String(name || "").match(/\.[^.\\/]+$/) || [""])[0].toLowerCase();
const u8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
const latin1 = new TextDecoder("latin1");

// ------------------------------------------------------------------ sniffing ---
function isZip(b) { return b.length > 30 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04; }

/** Zip entry names from the central directory (nothing is inflated). */
export function zipNames(b) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  const names = [];
  if (eocd < 0) return names;
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  for (let k = 0; k < count && p + 46 <= b.length; k++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const nlen = view.getUint16(p + 28, true), xlen = view.getUint16(p + 30, true), clen = view.getUint16(p + 32, true);
    names.push(latin1.decode(b.subarray(p + 46, p + 46 + nlen)));
    p += 46 + nlen + xlen + clen;
  }
  return names;
}

function looksLikeText(b, n = 4096) {
  const s = b.subarray(0, n);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === 0 || (c < 9) || (c > 13 && c < 32 && c !== 27)) return false;
  }
  return true;
}

/** "stl-binary" | "stl-ascii" | "3mf" | null */
export function sniffModel(bytes) {
  const b = u8(bytes);
  if (isZip(b)) {
    const names = zipNames(b);
    return names.some((n) => /\.model$/i.test(n)) ? "3mf" : null;
  }
  // ASCII first: a binary STL whose 80-byte header happens to start with "solid"
  // still has float data after it, so it never looks like text for 4 KB.
  const head = latin1.decode(b.subarray(0, 512)).replace(/^\xEF\xBB\xBF/, "").trimStart().toLowerCase();
  const text = looksLikeText(b);
  if (head.startsWith("solid") && text) return "stl-ascii";
  if (b.length >= 84 && !text) {
    const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(80, true);
    if (84 + 50 * n === b.length) return "stl-binary";
    if (n > 0 && 84 + 50 * n <= b.length) return "stl-binary";     // trailing junk after the triangles
  }
  if (b.length >= 84) {
    const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(80, true);
    if (84 + 50 * n === b.length) return "stl-binary";
  }
  return null;
}

function jsonKind(text) {
  let d;
  try { d = JSON.parse(text); } catch { return null; }
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  if (d.format === SCENE_FORMAT) return "scene";
  if (typeof d.textContent === "string" || typeof d.textLanguage === "string" || d.mode === "Text" || d.mode === "Blocks") return "program";
  return null;
}

/** What the file is, by extension first and content second.
 *  -> "model" | "scene" | "program" | null (unknown) */
export function detectFileKind(name, bytes) {
  const e = extOf(name);
  const b = bytes ? u8(bytes) : null;
  if (MODEL_EXTS.includes(e)) return "model";
  if (b && sniffModel(b)) return "model";                            // a renamed .stl / .3mf
  if (SCENE_EXTS.includes(e)) {
    if (b && looksLikeText(b)) return jsonKind(new TextDecoder().decode(b)) || "scene";
    return "scene";
  }
  if (PROJECT_EXTS.includes(e)) return "program";
  if (!b) return null;
  if (!looksLikeText(b)) return null;
  const text = new TextDecoder().decode(b);
  if (text.trimStart().startsWith("{")) return jsonKind(text);
  if (/^\s*(from\s+\w+\s+import|import\s+\w+|#)/.test(text) || /\barm\s*\.\s*\w+\s*\(/.test(text)) return "program";
  return null;
}

export const KIND_LABEL = { model: "a 3D model", scene: "a scene file", program: "a program" };

// ----------------------------------------------------------------------- STL ---
export function parseSTL(bytes) {
  const b = u8(bytes);
  const kind = sniffModel(b);
  if (kind === "stl-binary") {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const n = view.getUint32(80, true);
    const out = new Float32Array(n * 9);
    for (let i = 0, o = 84; i < n; i++, o += 50) {
      for (let k = 0; k < 9; k++) out[i * 9 + k] = view.getFloat32(o + 12 + k * 4, true);
    }
    return out;
  }
  if (kind === "stl-ascii") {
    const text = latin1.decode(b);
    const re = /vertex\s+([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\s+([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\s+([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)/g;
    const vals = [];
    let m;
    while ((m = re.exec(text))) vals.push(+m[1], +m[2], +m[3]);
    const n = Math.floor(vals.length / 9);
    if (!n) throw new Error("the ASCII STL has no 'facet ... vertex' lines");
    return Float32Array.from(vals.slice(0, n * 9));
  }
  if (kind === "3mf") throw new Error("this is a 3MF file (a zip), not an STL");
  throw new Error("not an STL file (neither binary nor ASCII 'solid ... facet' text)");
}

// ----------------------------------------------------------------------- 3MF ---
// A tiny XML tag scanner: 3MF model parts are almost pure markup, so we only
// look at the tags and skip text. Much lighter than DOMParser on a million vertices.
const TAG_RE = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)\s*>/g;
const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const local = (qn) => { const i = qn.indexOf(":"); return (i < 0 ? qn : qn.slice(i + 1)).toLowerCase(); };
const unesc = (s) => (s.includes("&") ? s.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g, (_, e) =>
  e === "amp" ? "&" : e === "lt" ? "<" : e === "gt" ? ">" : e === "quot" ? '"' : e === "apos" ? "'" : String.fromCodePoint(parseInt(e[1] === "x" ? e.slice(2) : e.slice(1), e[1] === "x" ? 16 : 10))) : s);

function attrsOf(src) {
  const a = {};
  if (!src) return a;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(src))) a[local(m[1])] = unesc(m[2] ?? m[3] ?? "");
  return a;
}

/** 3MF "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" -> 12 numbers (row-vector convention). */
export function parseTransform(s) {
  if (!s) return null;
  const t = s.trim().split(/[\s,]+/).map(Number);
  if (t.length !== 12 || t.some((v) => !Number.isFinite(v))) return null;
  return t;
}
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
/** apply(mul(A, B), p) === apply(A, apply(B, p))  (B first, then A). */
export function mulTransform(A, B) {
  const r = (M, i, j) => M[j * 3 + i];           // row i, column j of the 3x3 part
  const out = new Array(12);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[j * 3 + i] = r(A, i, 0) * r(B, 0, j) + r(A, i, 1) * r(B, 1, j) + r(A, i, 2) * r(B, 2, j);
  for (let i = 0; i < 3; i++) out[9 + i] = r(A, i, 0) * B[9] + r(A, i, 1) * B[10] + r(A, i, 2) * B[11] + A[9 + i];
  return out;
}
export function applyTransform(T, x, y, z) {
  return [T[0] * x + T[3] * y + T[6] * z + T[9], T[1] * x + T[4] * y + T[7] * z + T[10], T[2] * x + T[5] * y + T[8] * z + T[11]];
}
const det3 = (T) => T[0] * (T[4] * T[8] - T[7] * T[5]) - T[3] * (T[1] * T[8] - T[7] * T[2]) + T[6] * (T[1] * T[5] - T[4] * T[2]);

/** One .model part -> { unit, objects: Map(id -> object), build: [items] } */
export function parseModelPart(text) {
  const part = { unit: null, objects: new Map(), build: [] };
  const stack = [];
  let obj = null, mesh = null, inBuild = false;
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(text))) {
    if (m[1] !== undefined) {                                   // closing tag
      const name = local(m[1]);
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i] === name) { stack.length = i; break; }
      if (name === "object") obj = null;
      else if (name === "mesh") mesh = null;
      else if (name === "build") inBuild = false;
      continue;
    }
    if (m[2] === undefined) continue;                            // <?xml?>, comments, doctype
    const name = local(m[2]);
    const selfClose = m[4] === "/";
    const parent = stack[stack.length - 1];
    if (name === "vertex" && mesh && parent === "vertices") {
      const a = attrsOf(m[3]);
      mesh.vertices.push(+a.x || 0, +a.y || 0, +a.z || 0);
    } else if (name === "triangle" && mesh && parent === "triangles") {
      const a = attrsOf(m[3]);
      mesh.triangles.push(a.v1 | 0, a.v2 | 0, a.v3 | 0);
    } else if (name === "model") {
      const a = attrsOf(m[3]);
      part.unit = (a.unit || "millimeter").toLowerCase();
    } else if (name === "object" && parent === "resources") {
      const a = attrsOf(m[3]);
      obj = { id: a.id, type: (a.type || "model").toLowerCase(), name: a.name || "", mesh: null, components: [] };
      if (a.id != null) part.objects.set(a.id, obj);
    } else if (name === "mesh" && obj) {
      mesh = obj.mesh = { vertices: [], triangles: [] };
    } else if (name === "component" && obj && parent === "components") {
      const a = attrsOf(m[3]);
      obj.components.push({ objectId: a.objectid, path: a.path || null, transform: parseTransform(a.transform) });
    } else if (name === "build") {
      inBuild = true;
    } else if (name === "item" && inBuild) {
      const a = attrsOf(m[3]);
      part.build.push({ objectId: a.objectid, path: a.path || null, transform: parseTransform(a.transform) });
    }
    if (!selfClose) stack.push(name);
  }
  return part;
}

const normPath = (p) => String(p || "").replace(/^\/+/, "").replace(/\\/g, "/");

/** Find the zip entry for a part path (exact, then case-insensitive). */
function entryFor(zip, path) {
  const p = normPath(path);
  if (zip[p]) return p;
  const lower = p.toLowerCase();
  return Object.keys(zip).find((k) => k.toLowerCase() === lower) || null;
}

/** Root model part from _rels/.rels, with sensible fallbacks. */
function rootModelName(zip) {
  const rels = Object.keys(zip).find((k) => /^_rels\/\.rels$/i.test(k));
  if (rels) {
    const text = latin1.decode(zip[rels]);
    const re = /<Relationship\b([^>]*)\/?>/gi;
    let m;
    while ((m = re.exec(text))) {
      const a = attrsOf(m[1]);
      if (/3dmodel/i.test(a.type || "") && a.target) { const e = entryFor(zip, a.target); if (e) return e; }
    }
  }
  const models = Object.keys(zip).filter((k) => /\.model$/i.test(k));
  return models.find((k) => /^3d\/3dmodel\.model$/i.test(k)) || models.find((k) => /^3d\/[^/]+\.model$/i.test(k)) || models[0] || null;
}

/** Bytes of a .3mf -> { positions (mm), unit, unitScale, items, parts, warnings } */
export function parse3MF(bytes) {
  const b = u8(bytes);
  if (!isZip(b)) throw new Error("not a valid .3mf file (it should be a zip)");
  let zip;
  try { zip = fflate.unzipSync(b); } catch (e) { throw new Error("not a valid .3mf file (the zip could not be read)"); }
  const root = rootModelName(zip);
  if (!root) throw new Error("the 3MF has no 3D/3dmodel.model part inside");
  const parts = new Map();
  const warnings = [];
  const utf8 = new TextDecoder();
  const partOf = (path) => {
    const e = entryFor(zip, path);
    if (!e) return null;
    if (!parts.has(e)) parts.set(e, parseModelPart(utf8.decode(zip[e])));
    return parts.get(e);
  };
  const rootPart = partOf(root);
  const unit = rootPart.unit || "millimeter";
  const unitScale = UNITS_TO_MM[unit] ?? 1;
  if (!(unit in UNITS_TO_MM)) warnings.push(`unknown unit "${unit}", assuming millimeters`);

  let out = new Float32Array(9 * 1024), n = 0;
  let triangles = 0;
  const emitMesh = (mesh, T) => {
    const v = mesh.vertices, t = mesh.triangles;
    const flip = det3(T) < 0;                     // mirrored: swap two corners so the faces still point outwards
    const nv = v.length / 3;
    if (n + t.length * 3 > out.length) { const bigger = new Float32Array(Math.max(out.length * 2, n + t.length * 3)); bigger.set(out.subarray(0, n)); out = bigger; }
    for (let i = 0; i + 2 < t.length; i += 3) {
      const i1 = t[i], i2 = flip ? t[i + 2] : t[i + 1], i3 = flip ? t[i + 1] : t[i + 2];
      if (i1 >= nv || i2 >= nv || i3 >= nv) continue;
      for (const k of [i1, i2, i3]) {
        const x = v[k * 3], y = v[k * 3 + 1], z = v[k * 3 + 2];
        out[n++] = T[0] * x + T[3] * y + T[6] * z + T[9];
        out[n++] = T[1] * x + T[4] * y + T[7] * z + T[10];
        out[n++] = T[2] * x + T[5] * y + T[8] * z + T[11];
      }
      triangles++;
    }
  };
  const SKIP_TYPES = new Set(["support", "surface", "other"]);
  const emitObject = (partName, part, id, T, depth, seen) => {
    const o = part.objects.get(String(id));
    if (!o) { warnings.push(`object ${id} not found in ${partName}`); return; }
    if (SKIP_TYPES.has(o.type)) return;
    if (depth > 32 || seen.has(partName + "#" + id)) { warnings.push(`component loop at object ${id}`); return; }
    if (o.mesh) emitMesh(o.mesh, T);
    for (const c of o.components) {
      const Tc = c.transform ? mulTransform(T, c.transform) : T;
      let cPart = part, cName = partName;
      if (c.path) { cName = entryFor(zip, c.path) || c.path; cPart = partOf(c.path); if (!cPart) { warnings.push(`missing part ${c.path}`); continue; } }
      emitObject(cName, cPart, c.objectId, Tc, depth + 1, new Set([...seen, partName + "#" + id]));
    }
  };
  let items = rootPart.build;
  if (!items.length) {                              // no <build>: show the top-level objects of every part instead of nothing
    warnings.push("the file has no build items; showing all objects");
    items = [];
    const partNames = Object.keys(zip).filter((k) => /\.model$/i.test(k));
    const used = new Set();
    for (const k of partNames) for (const o of partOf(k).objects.values()) for (const c of o.components) used.add((c.path ? entryFor(zip, c.path) || c.path : k) + "#" + c.objectId);
    for (const k of partNames) for (const [id, o] of partOf(k).objects) if ((o.mesh || o.components.length) && !used.has(k + "#" + id)) items.push({ objectId: id, path: k, transform: null });
  }
  for (const it of items) {
    let part = rootPart, name = root;
    if (it.path) { name = entryFor(zip, it.path) || it.path; part = partOf(it.path); if (!part) { warnings.push(`missing part ${it.path}`); continue; } }
    emitObject(name, part, it.objectId, it.transform || IDENTITY, 0, new Set());
  }
  if (!triangles) throw new Error(warnings.length ? `the file has no triangles (${warnings[0]})` : "the file has no triangles");
  const positions = out.slice(0, n);
  if (unitScale !== 1) for (let i = 0; i < positions.length; i++) positions[i] *= unitScale;
  return { positions, unit, unitScale, items: items.length, parts: parts.size, triangles, warnings };
}

/** Any model file -> { positions (mm), fmt: "STL" | "3MF", notes: [human readable] } */
export function parseModelBytes(bytes, name = "") {
  const b = u8(bytes);
  const kind = sniffModel(b);
  const e = extOf(name);
  if (kind === "3mf" || (!kind && e === ".3mf")) {
    const r = parse3MF(b);
    const notes = [];
    if (r.unitScale !== 1) notes.push(`converted from ${r.unit === "meter" ? "meters" : r.unit + "s"} to mm`);
    if (r.items > 1) notes.push(`${r.items} objects combined`);
    return { positions: r.positions, fmt: "3MF", notes, info: r };
  }
  if (kind === "stl-binary" || kind === "stl-ascii") return { positions: parseSTL(b), fmt: "STL", notes: [], info: { kind } };
  if (e === ".stl") throw new Error("not an STL file (neither binary nor ASCII 'solid ... facet' text)");
  throw new Error(`only .stl and .3mf models can be imported (${name || "this file"} is neither)`);
}
