// fixtures.mjs - small model files built in memory for the node and browser tests:
// ASCII / binary STL cubes and 3MF archives (plain, and with the production
// extension the way Bambu Studio / PrusaSlicer write them).
import * as fflate from "../vendor/three/addons/fflate.module.js";

const enc = new TextEncoder();

/** 12 triangles of an axis-aligned box [x0,x1]x[y0,y1]x[z0,z1], outward winding. */
export function boxTriangles([x0, y0, z0], [x1, y1, z1]) {
  const v = (x, y, z) => [x ? x1 : x0, y ? y1 : y0, z ? z1 : z0];
  const quad = (a, b, c, d) => [[a, b, c], [a, c, d]];
  return [
    ...quad(v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)),   // bottom (z0), normal -z
    ...quad(v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)),   // top
    ...quad(v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)),   // front (y0), normal -y
    ...quad(v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)),   // back
    ...quad(v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)),   // left (x0), normal -x
    ...quad(v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)),   // right
  ];
}

export function asciiSTL(tris, name = "cube") {
  const lines = [`solid ${name}`];
  for (const [a, b, c] of tris) {
    lines.push("  facet normal 0 0 0", "    outer loop");
    for (const p of [a, b, c]) lines.push(`      vertex ${p.map((v) => v.toExponential(6)).join(" ")}`);
    lines.push("    endloop", "  endfacet");
  }
  lines.push(`endsolid ${name}`, "");
  return enc.encode(lines.join("\n"));
}

export function binarySTL(tris, header = "binary stl made by the tests") {
  const buf = new ArrayBuffer(84 + 50 * tris.length);
  const view = new DataView(buf);
  new Uint8Array(buf, 0, 80).set(enc.encode(header.padEnd(80).slice(0, 80)));
  view.setUint32(80, tris.length, true);
  tris.forEach(([a, b, c], i) => {
    const o = 84 + 50 * i;
    for (let k = 0; k < 3; k++) view.setFloat32(o + k * 4, 0, true);           // normal
    [a, b, c].forEach((p, j) => p.forEach((v, k) => view.setFloat32(o + 12 + j * 12 + k * 4, v, true)));
    view.setUint16(o + 48, 0, true);
  });
  return new Uint8Array(buf);
}

/** Signed volume of a triangle soup (positive = outward winding). */
export function signedVolume(p) {
  let v = 0;
  for (let i = 0; i < p.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = p.subarray ? p.subarray(i, i + 9) : p.slice(i, i + 9);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

export function bounds(p) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i + k]); hi[k] = Math.max(hi[k], p[i + k]); }
  return [lo, hi];
}
export const sizeOf = (p) => { const [lo, hi] = bounds(p); return lo.map((v, k) => hi[k] - v); };

// -------------------------------------------------------------------- 3MF ---
const CORE_NS = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const PROD_NS = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";

function meshXml(tris) {
  const verts = [], idx = new Map(), t = [];
  for (const tri of tris) {
    const ids = tri.map((p) => { const k = p.join(","); if (!idx.has(k)) { idx.set(k, verts.length); verts.push(p); } return idx.get(k); });
    t.push(ids);
  }
  return `<mesh><vertices>${verts.map((p) => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join("")}</vertices>` +
    `<triangles>${t.map((i) => `<triangle v1="${i[0]}" v2="${i[1]}" v3="${i[2]}"/>`).join("")}</triangles></mesh>`;
}
const rels = (targets) => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  targets.map((t, i) => `<Relationship Target="${t}" Id="rel${i}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`).join("") + `</Relationships>`;
const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;

/** Plain core-spec 3MF: one model part, objects in it, build items with optional transforms. */
export function simple3MF({ unit = "millimeter", objects, items }) {
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="${unit}" xml:lang="en-US" xmlns="${CORE_NS}"><metadata name="Title">test</metadata><resources>` +
    objects.map((o) => `<object id="${o.id}" type="${o.type || "model"}"${o.name ? ` name="${o.name}"` : ""}>${meshXml(o.tris)}</object>`).join("") +
    `</resources><build>` + items.map((it) => `<item objectid="${it.objectId}"${it.transform ? ` transform="${it.transform}"` : ""}/>`).join("") + `</build></model>`;
  return fflate.zipSync({ "[Content_Types].xml": enc.encode(contentTypes), "_rels/.rels": enc.encode(rels(["/3D/3dmodel.model"])), "3D/3dmodel.model": enc.encode(model) });
}

/** Production-extension 3MF like Bambu Studio / PrusaSlicer 2.7+: the root part only
 * has component objects pointing (p:path) at 3D/Objects/object_N.model parts. Object
 * ids repeat across parts on purpose (id "1" in every part) - the spec allows it. */
export function production3MF({ unit = "millimeter", parts, build }) {
  const files = { "[Content_Types].xml": enc.encode(contentTypes), "_rels/.rels": enc.encode(rels(["/3D/3dmodel.model"])) };
  const rootObjects = [];
  parts.forEach((p, i) => {
    const path = `3D/Objects/object_${i + 1}.model`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?><model unit="${unit}" xmlns="${CORE_NS}" xmlns:p="${PROD_NS}"><resources>` +
      `<object id="1" p:UUID="00000000-0000-0000-0000-00000000000${i + 1}" type="model"${p.name ? ` name="${p.name}"` : ""}>${meshXml(p.tris)}</object>` +
      `</resources><build/></model>`;
    files[path] = enc.encode(xml);
    rootObjects.push(`<object id="${(i + 1) * 2}" p:UUID="10000000-0000-0000-0000-00000000000${i + 1}" type="model"><components>` +
      `<component p:path="/${path}" objectid="1" p:UUID="20000000-0000-0000-0000-00000000000${i + 1}"${p.componentTransform ? ` transform="${p.componentTransform}"` : ""}/></components></object>`);
  });
  const root = `<?xml version="1.0" encoding="UTF-8"?><model unit="${unit}" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:p="${PROD_NS}" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">` +
    `<metadata name="Application">BambuStudio-01.09.00.70</metadata><resources>${rootObjects.join("")}</resources><build p:UUID="d8eb061-b1ec-4553-aec9-835e5b724bb4">` +
    build.map((b, i) => `<item objectid="${(b.part + 1) * 2}" p:UUID="30000000-0000-0000-0000-00000000000${i + 1}"${b.transform ? ` transform="${b.transform}"` : ""} printable="1"/>`).join("") +
    `</build></model>`;
  files["3D/3dmodel.model"] = enc.encode(root);
  files["3D/_rels/3dmodel.model.rels"] = enc.encode(rels(parts.map((_, i) => `/3D/Objects/object_${i + 1}.model`)));
  files["Metadata/model_settings.config"] = enc.encode("<config/>");
  return fflate.zipSync(files);
}

export const translate = (x, y, z) => `1 0 0 0 1 0 0 0 1 ${x} ${y} ${z}`;
export const mirrorX = (x = 0, y = 0, z = 0) => `-1 0 0 0 1 0 0 0 1 ${x} ${y} ${z}`;
export const cube = (s, at = [0, 0, 0]) => boxTriangles(at, at.map((v) => v + s));
