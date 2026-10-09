// renderer.js - three.js drawing of the arm, table, objects and overlays.
// Same look as the v4 OpenGL renderer (sim.py): the arm is built from simple
// cylinders placed along the forward-kinematics points; Z is up; mm units.
import * as THREE from "../vendor/three/three.module.min.js";
import { OrbitControls } from "../vendor/three/addons/OrbitControls.js";
import * as cfg from "./arm_config.js";
import * as kin from "./kinematics.js";

export const C_LINK = [0.86, 0.87, 0.89];
export const C_HOUSING = [0.26, 0.28, 0.32];
export const C_SELECTED = [1.0, 0.78, 0.1];
export const C_LIMIT = [0.92, 0.12, 0.12];
export const C_BASE = [0.18, 0.19, 0.22];
export const C_TOOL = [0.55, 0.57, 0.6];
const RED = [0.93, 0.2, 0.2];
const BG = [0.93, 0.95, 0.98];

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const colorOf = (c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
const Z = new THREE.Vector3(0, 0, 1);

// unit cylinder from z = 0 to z = 1, radius 1
const CYL = new THREE.CylinderGeometry(1, 1, 1, 28, 1, false).rotateX(Math.PI / 2).translate(0, 0, 0.5);
const BOX = new THREE.BoxGeometry(1, 1, 1);
const BOX_FLOOR = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);    // sits on z = 0
const SPHERE = new THREE.SphereGeometry(1, 24, 16);

export class Renderer {
  constructor(canvas, app) {
    this.app = app;
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
    this.gl.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.scene.background = colorOf(BG);
    this.camera = new THREE.PerspectiveCamera(40, 1, 10, 8000);
    this.camera.up.set(0, 0, 1);
    this.controls = null;          // made by attachControls() (after app pointer handlers)
    this.platformKey = null;
    this.pool = [];
    this.poolUsed = 0;
    this.armGroup = new THREE.Group();
    this.scene.add(this.armGroup);
    this.objMeshes = new Map();
    this.modelMeshes = new Map();
    this.trailKey = null;
    this.pathKey = null;
    this.reachKey = null;
    this.setupLights();
    this.floor = new THREE.Group();
    this.scene.add(this.floor);
    this.makeAxes();
    this.makeOverlays();
  }

  attachControls() {
    const c = new OrbitControls(this.camera, this.canvas);
    c.enableDamping = false;
    c.minDistance = 150; c.maxDistance = 3500;
    c.minPolarAngle = THREE.MathUtils.degToRad(1);
    c.maxPolarAngle = THREE.MathUtils.degToRad(95);       // a little below the table, like v4
    c.rotateSpeed = 0.8; c.zoomSpeed = 1.0; c.panSpeed = 1.0;
    c.screenSpacePanning = true;
    c.keys = {};
    this.controls = c;
    this.resetCamera();
  }

  setupLights() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa3ad, 1.55));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(350, -250, 1000);
    sun.target.position.set(0, 0, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    sun.shadow.radius = 3;
    const s = sun.shadow.camera;
    s.near = 100; s.far = 2600; s.left = -700; s.right = 700; s.top = 700; s.bottom = -700;
    this.sun = sun;
    this.scene.add(sun, sun.target);
    const fill = new THREE.DirectionalLight(0xffffff, 0.45);
    fill.position.set(-600, 700, 300);
    this.scene.add(fill);
  }

  // ---------------------------------------------------------------- camera ---
  resetCamera() {
    let az = -55, el = 26, dist = 820, center = [110, 0, 110];
    const p = this.app.c.platform;
    if (p) {
      const [pw, pd] = p.size;
      const scale = Math.max(1, pw / 638, pd / 420);
      dist = 820 * scale;
      const [cx, cy] = p.center;
      center = [110 + (cx - 100) * 0.6, cy, 110 * Math.min(scale, 1.6)];
    }
    const a = THREE.MathUtils.degToRad(az), e = THREE.MathUtils.degToRad(el);
    const t = v3(center);
    this.camera.position.set(t.x + dist * Math.cos(e) * Math.cos(a), t.y + dist * Math.cos(e) * Math.sin(a), t.z + dist * Math.sin(e));
    if (this.controls) { this.controls.target.copy(t); this.controls.update(); } else this.camera.lookAt(t);
    const s = Math.max(1, Math.max(...p.size) / 700);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -700 * s; sc.right = sc.top = 700 * s; sc.far = 2600 * s;
    sc.updateProjectionMatrix();
  }

  resize(w, h) {
    this.w = w; this.h = h;
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  /** world -> CSS pixel in the canvas, or null if behind the camera */
  project(p) {
    const v = v3(p).project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    return [(v.x + 1) / 2 * this.w, (1 - v.y) / 2 * this.h];
  }
  ray(mx, my) {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(mx / this.w * 2 - 1, 1 - my / this.h * 2), this.camera);
    return rc.ray;
  }
  floorPoint(mx, my, z = 0) {
    const r = this.ray(mx, my);
    if (Math.abs(r.direction.z) < 1e-6) return null;
    const t = (z - r.origin.z) / r.direction.z;
    if (t <= 0) return null;
    return [r.origin.x + r.direction.x * t, r.origin.y + r.direction.y * t, z];
  }
  static rayBox(ray, lo, hi) {
    const b = new THREE.Box3(v3(lo), v3(hi));
    const hit = ray.intersectBox(b, new THREE.Vector3());
    return hit ? hit.distanceTo(ray.origin) : null;
  }

  // ----------------------------------------------------------------- floor ---
  buildFloor() {
    const p = this.app.c.platform;
    const key = `${p.width}x${p.depth}`;
    if (key === this.platformKey) return;
    this.platformKey = key;
    for (const ch of [...this.floor.children]) { this.floor.remove(ch); ch.geometry?.dispose(); ch.material?.dispose(); }
    const [pw, ph] = p.size, [cx, cy] = p.center;
    const x0 = cx - pw / 2, x1 = cx + pw / 2, y0 = cy - ph / 2, y1 = cy + ph / 2;
    const m = 120;
    const tx0 = Math.min(-450, x0 - m), tx1 = Math.max(450, x1 + m), ty0 = Math.min(-450, y0 - m), ty1 = Math.max(450, y1 + m);
    const plane = (xa, xb, ya, yb, z, col) => {
      const g = new THREE.PlaneGeometry(xb - xa, yb - ya).translate((xa + xb) / 2, (ya + yb) / 2, z);
      const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: colorOf(col) }));
      mesh.receiveShadow = true;
      this.floor.add(mesh);
      return mesh;
    };
    plane(tx0, tx1, ty0, ty1, -0.6, [0.80, 0.82, 0.85]);
    plane(x0, x1, y0, y1, -0.4, [0.90, 0.92, 0.95]);
    // grid every 50 mm (darker every 100 mm)
    const pts = [], cols = [];
    const gx0 = Math.ceil((tx0 + 25) / 50) * 50, gx1 = Math.floor((tx1 - 25) / 50) * 50;
    const gy0 = Math.ceil((ty0 + 25) / 50) * 50, gy1 = Math.floor((ty1 - 25) / 50) * 50;
    const line = (a, b, major) => {
      pts.push(...a, ...b);
      const c = colorOf(major ? [0.62, 0.65, 0.70] : [0.74, 0.76, 0.80]);
      cols.push(c.r, c.g, c.b, c.r, c.g, c.b);
    };
    for (let v = gx0; v <= gx1; v += 50) line([v, gy0, 0], [v, gy1, 0], v % 100 === 0);
    for (let v = gy0; v <= gy1; v += 50) line([gx0, v, 0], [gx1, v, 0], v % 100 === 0);
    const gg = new THREE.BufferGeometry();
    gg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    gg.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    this.floor.add(new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ vertexColors: true })));
    // platform outline: thin flat strips (2.5 mm) so it shows at any zoom
    const om = new THREE.MeshBasicMaterial({ color: colorOf([0.45, 0.50, 0.58]) });
    const strip = (xa, xb, ya, yb) => {
      const g = new THREE.PlaneGeometry(xb - xa, yb - ya).translate((xa + xb) / 2, (ya + yb) / 2, 0.3);
      this.floor.add(new THREE.Mesh(g, om));
    };
    const w = 2.5;
    strip(x0 - w / 2, x1 + w / 2, y0 - w / 2, y0 + w / 2); strip(x0 - w / 2, x1 + w / 2, y1 - w / 2, y1 + w / 2);
    strip(x0 - w / 2, x0 + w / 2, y0, y1); strip(x1 - w / 2, x1 + w / 2, y0, y1);
  }

  makeAxes() {
    const g = new THREE.Group();
    for (const [d, c] of [[[1, 0, 0], [0.9, 0.1, 0.1]], [[0, 1, 0], [0.1, 0.7, 0.1]], [[0, 0, 1], [0.1, 0.3, 0.95]]]) {
      const m = new THREE.Mesh(CYL, new THREE.MeshBasicMaterial({ color: colorOf(c) }));
      this.placeCyl(m, [0, 0, 0.5], [d[0] * 120, d[1] * 120, d[2] * 120 + 0.5], 1.3);
      g.add(m);
    }
    this.scene.add(g);
  }

  // ------------------------------------------------------------------- arm ---
  placeCyl(mesh, p0, p1, r) {
    const a = v3(p0), d = v3(p1).sub(a);
    const len = d.length();
    if (len < 1e-6) { mesh.visible = false; return; }
    mesh.visible = true;
    mesh.position.copy(a);
    mesh.quaternion.setFromUnitVectors(Z, d.divideScalar(len));
    mesh.scale.set(r, r, len);
  }
  part(geom = CYL) {
    let m = this.pool[this.poolUsed];
    if (!m) {
      m = new THREE.Mesh(CYL, new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.08 }));
      m.castShadow = true; m.receiveShadow = true;
      this.pool.push(m); this.armGroup.add(m);
    }
    m.geometry = geom;
    m.visible = true;
    m.quaternion.identity();
    this.poolUsed++;
    return m;
  }
  cyl(p0, p1, r, col) { const m = this.part(CYL); m.material.color.copy(colorOf(col)); this.placeCyl(m, p0, p1, r); }
  housing(center, axis, length, r, col) {
    this.cyl(kin.sub(center, kin.scale(axis, length / 2)), kin.add(center, kin.scale(axis, length / 2)), r, col);
  }

  drawArm(fk, jointColors, toolType, magnetOn, hitLinks = new Set()) {
    this.poolUsed = 0;
    const f = fk.jointFrames;
    const pts = fk.points();
    const link = (k) => (hitLinks.has(k) ? RED : C_LINK);
    const ax = (i) => kin.col(f[i], kin.AXIS_INDEX[kin.CHAIN[i][1]]);
    this.cyl([0, 0, 0], [0, 0, 28], cfg.BASE_RADIUS, hitLinks.has("base") ? RED : C_BASE);
    this.cyl([0, 0, 28], [0, 0, 50], 44, jointColors[0]);
    const yawDir = kin.col(f[0], 0);
    const b = this.part(BOX);
    b.material.color.copy(colorOf([0.95, 0.95, 0.97]));
    b.position.set(yawDir[0] * 30, yawDir[1] * 30, 50 + yawDir[2] * 30);
    b.rotation.set(0, 0, Math.atan2(yawDir[1], yawDir[0]));
    b.scale.set(16, 10, 6);
    this.cyl([0, 0, 50], pts.shoulder, 28, link("base"));
    this.housing(pts.shoulder, ax(1), 74, cfg.JOINT_RADIUS + 3, jointColors[1]);
    this.cyl(pts.shoulder, pts.elbow, cfg.LINK_RADIUS, link("upper"));
    this.housing(pts.elbow, ax(2), 62, cfg.JOINT_RADIUS, jointColors[2]);
    const fd = kin.sub(pts.wrist, pts.elbow), fl = kin.norm(fd);
    const fdir = kin.scale(fd, 1 / fl);
    this.cyl(pts.elbow, pts.wrist, cfg.LINK_RADIUS - 3, link("forearm"));
    this.cyl(kin.add(pts.elbow, kin.scale(fdir, 55)), kin.add(pts.elbow, kin.scale(fdir, 85)), cfg.LINK_RADIUS + 1, jointColors[3]);
    const fin = kin.col(f[3], 2);
    const f70 = kin.add(pts.elbow, kin.scale(fdir, 70));
    this.cyl(f70, kin.add(f70, kin.scale(fin, 24)), 4, jointColors[3]);
    this.housing(pts.wrist, ax(4), 46, 14, jointColors[4]);
    const tdir = kin.col(fk.tcp, 0);
    this.cyl(pts.wrist, pts.flange, 10, link("wrist"));
    this.cyl(kin.sub(pts.flange, kin.scale(tdir, 6)), pts.flange, 15, jointColors[5]);
    const knob = kin.col(fk.flange, 1);
    const k0 = kin.sub(pts.flange, kin.scale(tdir, 3));
    this.cyl(k0, kin.add(k0, kin.scale(knob, 19)), 3, jointColors[5]);
    if (toolType === "PEN") {
      this.cyl(pts.flange, kin.sub(pts.tool, kin.scale(tdir, 12)), 7, hitLinks.has("tool") ? RED : [0.95, 0.95, 0.95]);
      this.cyl(kin.sub(pts.tool, kin.scale(tdir, 12)), pts.tool, 3, [0.1, 0.1, 0.1]);
    } else if (toolType === "MAGNET") {
      this.cyl(pts.flange, kin.sub(pts.tool, kin.scale(tdir, 4)), 8, hitLinks.has("tool") ? RED : C_TOOL);
      this.cyl(kin.sub(pts.tool, kin.scale(tdir, 4)), pts.tool, 11, magnetOn ? [0.95, 0.25, 0.1] : [0.3, 0.3, 0.32]);
    }
    for (let i = this.poolUsed; i < this.pool.length; i++) this.pool[i].visible = false;
  }

  // --------------------------------------------------------------- objects ---
  static tint(c, on) { return on ? c.map((v, i) => 0.65 * v + 0.35 * [0.35, 0.6, 1.0][i]) : c; }

  syncObjects(objects, highlight) {
    const seen = new Set();
    for (const ob of objects) {
      seen.add(ob);
      let m = this.objMeshes.get(ob);
      if (!m) {
        m = new THREE.Mesh(ob.kind === "disk" ? CYL : BOX_FLOOR, new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.05 }));
        m.castShadow = true; m.receiveShadow = true;
        this.scene.add(m);
        this.objMeshes.set(ob, m);
      }
      m.material.color.copy(colorOf(Renderer.tint(ob.color, ob === highlight)));
      m.position.set(ob.pos[0], ob.pos[1], ob.pos[2]);
      if (ob.kind === "disk") m.scale.set(ob.size / 2, ob.size / 2, ob.height);
      else m.scale.set(ob.size, ob.size, ob.height);
    }
    for (const [ob, m] of this.objMeshes) if (!seen.has(ob)) { this.scene.remove(m); m.material.dispose(); this.objMeshes.delete(ob); }
  }

  syncModels(models, highlight) {
    const seen = new Set();
    for (const md of models) {
      seen.add(md);
      let m = this.modelMeshes.get(md);
      if (!m) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(md.positions, 3));
        g.computeVertexNormals();
        m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05 }));
        m.castShadow = true; m.receiveShadow = true;
        this.modelMeshes.set(md, m);
      }
      if (!m.parent) this.scene.add(m);
      m.material.color.copy(colorOf(Renderer.tint(md.color, md === highlight)));
      m.position.set(...md.offset);
    }
    // meshes of removed models are kept (hidden) so undo can bring them back
    for (const [md, m] of this.modelMeshes) if (!seen.has(md) && m.parent) this.scene.remove(m);
  }

  // -------------------------------------------------------------- overlays ---
  makeOverlays() {
    // selection box (12 edges)
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.Float32BufferAttribute(new Array(72).fill(0), 3));
    this.selBox = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: 0x2666eb, depthTest: false, transparent: true }));
    this.selBox.renderOrder = 10;
    this.selBox.visible = false;
    this.scene.add(this.selBox);
    // target marker
    this.target = new THREE.Group();
    this.targetBall = new THREE.Mesh(SPHERE, new THREE.MeshStandardMaterial({ roughness: 0.4 }));
    this.targetBall.scale.setScalar(7);
    this.targetLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    this.target.add(this.targetBall, this.targetLines);
    this.target.visible = false;
    this.scene.add(this.target);
    // pen drawing (flat ribbon on the table), path trail, reach map, ghost
    this.trailMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: colorOf([0.05, 0.1, 0.6]), side: THREE.DoubleSide }));
    this.scene.add(this.trailMesh);
    // path trail: two crossed thin ribbons per segment (WebGL lines are always 1 px, too faint)
    this.pathLine = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    this.pathLine.visible = false;
    this.scene.add(this.pathLine);
    this.reachTable = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: colorOf([0.13, 0.75, 0.37]), transparent: true, opacity: 0.30, depthWrite: false, side: THREE.DoubleSide }));
    this.reachBand = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: colorOf([0.25, 0.55, 0.95]), transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide }));
    this.reachTable.visible = this.reachBand.visible = false;
    this.scene.add(this.reachTable, this.reachBand);
    this.ghost = new THREE.Group();
    this.ghostBox = new THREE.Mesh(BOX_FLOOR, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false }));
    this.ghostEdge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([v3([-0.5, -0.5, 0]), v3([0.5, -0.5, 0]), v3([0.5, 0.5, 0]), v3([-0.5, 0.5, 0])]), new THREE.LineBasicMaterial());
    this.ghost.add(this.ghostBox, this.ghostEdge);
    this.ghost.visible = false;
    this.scene.add(this.ghost);
  }

  setSelection(lo, hi, color) {
    if (!lo) { this.selBox.visible = false; return; }
    const pad = 4;
    const xs = [lo[0] - pad, hi[0] + pad], ys = [lo[1] - pad, hi[1] + pad], zs = [Math.max(lo[2], 0.3), hi[2] + pad];
    const a = [];
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      a.push(xs[0], ys[i], zs[j], xs[1], ys[i], zs[j]);
      a.push(xs[i], ys[0], zs[j], xs[i], ys[1], zs[j]);
      a.push(xs[i], ys[j], zs[0], xs[i], ys[j], zs[1]);
    }
    const attr = this.selBox.geometry.attributes.position;
    attr.array.set(a); attr.needsUpdate = true;
    this.selBox.geometry.computeBoundingSphere();
    this.selBox.material.color.copy(colorOf(color));
    this.selBox.visible = true;
  }

  setTarget(p, ok) {
    if (!p) { this.target.visible = false; return; }
    const c = ok ? [0.1, 0.8, 0.25] : [0.95, 0.1, 0.1];
    const key = `${p.join(",")}|${ok}`;
    this.target.visible = true;
    if (key === this._targetKey) return;
    this._targetKey = key;
    this.targetBall.position.set(...p);
    this.targetBall.material.color.copy(colorOf(c));
    const a = [];
    for (let k = 0; k < Math.max(p[2], 0); k += 12) a.push(p[0], p[1], k, p[0], p[1], Math.min(k + 6, p[2]));
    a.push(p[0] - 18, p[1], 0.6, p[0] + 18, p[1], 0.6, p[0], p[1] - 18, 0.6, p[0], p[1] + 18, 0.6);
    this.targetLines.geometry.dispose();
    this.targetLines.geometry = new THREE.BufferGeometry();
    this.targetLines.geometry.setAttribute("position", new THREE.Float32BufferAttribute(a, 3));
    this.targetLines.material.color.copy(colorOf(c));
  }

  /** Pen drawing: list of points with null between strokes -> 2.6 mm wide ribbon. */
  setTrail(trail, version) {
    if (version === this.trailKey) return;
    this.trailKey = version;
    const a = [];
    const w = 1.3;
    let prev = null;
    for (const p of trail) {
      if (!p) { prev = null; continue; }
      if (prev) {
        const dx = p[0] - prev[0], dy = p[1] - prev[1], L = Math.hypot(dx, dy);
        if (L > 1e-6) {
          const nx = -dy / L * w, ny = dx / L * w, ex = dx / L * w * 0.5, ey = dy / L * w * 0.5;
          const A = [prev[0] + nx - ex, prev[1] + ny - ey], B = [prev[0] - nx - ex, prev[1] - ny - ey];
          const C = [p[0] - nx + ex, p[1] - ny + ey], D = [p[0] + nx + ex, p[1] + ny + ey];
          a.push(...A, 0.8, ...B, 0.8, ...C, 0.8, ...A, 0.8, ...C, 0.8, ...D, 0.8);
        }
      }
      prev = p;
    }
    this.trailMesh.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(a, 3));
    this.trailMesh.geometry = g;
  }

  setPath(pts, show, version) {
    this.pathLine.visible = show && pts.length > 1;
    if (!this.pathLine.visible || version === this.pathKey) return;
    this.pathKey = version;
    const W = 1.1;                                        // half width, mm
    const n = pts.length, segs = n - 1;
    const pos = new Float32Array(segs * 8 * 3), col = new Float32Array(segs * 8 * 4), idx = [];
    const c = colorOf([0.5, 0.15, 0.85]);
    let v = 0;
    for (let i = 0; i < segs; i++) {
      const p0 = pts[i], p1 = pts[i + 1];
      const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      let s1 = [d[1], -d[0], 0];                          // horizontal side vector (d x Z)
      let l1 = Math.hypot(s1[0], s1[1]);
      if (l1 < 1e-6) { s1 = [1, 0, 0]; l1 = 1; }
      s1 = s1.map((x) => (x / l1) * W);
      let s2 = [d[1] * s1[2] - d[2] * s1[1], d[2] * s1[0] - d[0] * s1[2], d[0] * s1[1] - d[1] * s1[0]];
      const l2 = Math.hypot(...s2) || 1;
      s2 = s2.map((x) => (x / l2) * W);
      const a0 = 0.25 + 0.6 * (i / n), a1 = 0.25 + 0.6 * ((i + 1) / n);
      for (const sv of [s1, s2]) {
        const quad = [[p0, -1, a0], [p0, 1, a0], [p1, 1, a1], [p1, -1, a1]];
        for (const [p, k, al] of quad) {
          pos.set([p[0] + k * sv[0], p[1] + k * sv[1], p[2] + k * sv[2]], v * 3);
          col.set([c.r, c.g, c.b, al], v * 4);
          v++;
        }
        idx.push(v - 4, v - 3, v - 2, v - 4, v - 2, v - 1);
      }
    }
    this.pathLine.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 4));
    g.setIndex(idx);
    this.pathLine.geometry = g;
  }

  setReach(rm, show) {
    this.reachTable.visible = show && !!rm.table;
    this.reachBand.visible = show && !!rm.band;
    if (!show || rm.version === this.reachKey) return;
    this.reachKey = rm.version;
    const build = (data, z) => {
      const a = [];
      if (data) {
        const h = data.cell / 2;
        data.xs.forEach((x, i) => data.ys.forEach((y, j) => {
          if (data.mask[i][j]) a.push(x - h, y - h, z, x + h, y - h, z, x + h, y + h, z, x - h, y - h, z, x + h, y + h, z, x - h, y + h, z);
        }));
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(a, 3));
      return g;
    };
    this.reachTable.geometry.dispose(); this.reachTable.geometry = build(rm.table, 0.35);
    this.reachBand.geometry.dispose(); this.reachBand.geometry = build(rm.band, rm.height);
  }

  setGhost(g) {
    if (!g) { this.ghost.visible = false; return; }
    const col = colorOf(g.ok ? [0.13, 0.65, 0.3] : [0.9, 0.15, 0.15]);
    this.ghost.visible = true;
    this.ghost.position.set(g.x, g.y, 0.5);
    this.ghostBox.scale.set(2 * g.hx, 2 * g.hy, Math.max(1, g.h));
    this.ghostEdge.scale.set(2 * g.hx, 2 * g.hy, 1);
    this.ghostEdge.position.z = 0.3;
    this.ghostBox.material.color.copy(col);
    this.ghostEdge.material.color.copy(col);
  }

  render() { this.gl.render(this.scene, this.camera); }
}
