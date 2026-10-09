// End-to-end browser test for the Virtual 6-Axis Arm web app (Playwright, headless Chromium).
//   1. serve the site:   python -m http.server 8000      (in the site folder)
//   2. npm i playwright && npx playwright install chromium
//   3. node tests/e2e_browser.mjs http://localhost:8000/ [screenshots-folder]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asciiSTL, binarySTL, cube, production3MF, translate } from "./fixtures.mjs";

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), process.env.SITE_DIR || "..");
const URL0 = process.argv[2] || "http://localhost:8000/";
const SHOTS = process.argv[3] || path.join(SITE, "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });
const expected = JSON.parse(fs.readFileSync(path.join(SITE, "tests/expected_sample_results.json"), "utf8"));
const results = [];
const check = async (name, fn) => {
  const t0 = Date.now();
  try { const info = await fn(); results.push([true, name, info ?? ""]); console.log(`PASS ${name} ${info ?? ""} (${Date.now() - t0} ms)`); }
  catch (e) { results.push([false, name, e.message]); console.log(`FAIL ${name}: ${e.message}`); }
};
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

async function openPage(viewport = { width: 1440, height: 900 }, setup = null) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  if (setup) await setup(ctx);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("console", (m) => { if (m.type() === "error") page.errors.push(m.text()); });
  page.on("pageerror", (e) => page.errors.push("pageerror: " + e.message));
  await page.goto(URL0);
  await page.waitForFunction(() => window.app && window.app.frames > 5, null, { timeout: 30000 });
  await page.evaluate(() => app.ready);
  return page;
}
const shot = async (page, name) => { await page.waitForTimeout(250); return page.screenshot({ path: path.join(SHOTS, name) }); };  // let CSS transitions finish
const waitIdle = (page, ms = 120000) => page.waitForFunction(() => !app.host.running && app.c.isDone(), null, { timeout: ms, polling: 100 });
const waitArm = (page) => page.waitForFunction(() => app.c.isDone(), null, { timeout: 30000, polling: 100 });

const page = await openPage();

await check("page loads, arm renders, no console errors", async () => {
  const info = await page.evaluate(() => ({ tris: app.renderer.gl.info.render.triangles, calls: app.renderer.gl.info.render.calls,
    pos: app.c.position().map((v) => +v.toFixed(2)), objs: app.c.objects.length }));
  assert(info.tris > 1000 && info.calls > 10, "nothing drawn " + JSON.stringify(info));
  assert(Math.abs(info.pos[0] - 120) < 0.1 && Math.abs(info.pos[2] - 100) < 0.1, "not at home " + info.pos);
  assert(page.errors.length === 0, page.errors.join(" | "));
  await shot(page, "01_start.png");
  return `${info.tris} triangles, ${info.calls} draw calls`;
});

await check("real CTE Tile: 333 x 333 mm with the arm on location 8, Workcell preset, objects on Tile locations", async () => {
  const r = await page.evaluate(() => ({ size: app.c.platform.size, center: app.c.platform.center, bounds: app.c.platform.bounds(),
    presets: [...document.querySelectorAll('#presets button[data-action="platform_preset"]')].map((b) => `${b.textContent}:${b.dataset.arg}`),
    objs: app.c.objects.map((o) => `${o.name}@${o.pos.slice(0, 2)}`), shoulder: app.c.fk().points().shoulder.map((v) => +v.toFixed(1)) }));
  assert(r.size.join("x") === "333x333" && r.center.join(",") === "75,75", JSON.stringify(r));
  assert(r.bounds.every((v, i) => Math.abs(v - [-91.5, 241.5, -91.5, 241.5][i]) < 1e-9), "bounds " + r.bounds);
  assert(r.presets[0] === "CTE Tile:333,333" && r.presets[1] === "Workcell:333,638", r.presets.join(" | "));
  assert(r.objs.join(" ") === "Red cube@150,50 Blue cube@150,150 Green disk@50,200", r.objs.join(" "));
  assert(r.shoulder.join(",") === "20.5,0,84", "shoulder " + r.shoulder);
  return `${r.size.join("×")} mm, base at ${r.center}, shoulder (${r.shoulder}); presets ${r.presets.map((p) => p.split(":")[0]).join(", ")}`;
});

await check("joint slider drag moves J1", async () => {
  const sl = page.locator('.joint[data-joint="0"] .slider');
  const b = await sl.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.75, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
  await waitArm(page);
  const q0 = await page.evaluate(() => app.c.q[0]);
  assert(q0 > 30, "J1 = " + q0);
  return `J1 = ${q0.toFixed(1)}°`;
});

await check("Home key returns to (120, 0, 100)", async () => {
  await page.locator("#c3d").click({ position: { x: 40, y: 400 } });
  await page.keyboard.press("h");
  await waitArm(page);
  const p = await page.evaluate(() => app.c.position());
  assert(Math.hypot(p[0] - 120, p[1], p[2] - 100) < 0.05, "pos " + p);
});

await check("jog keys move the tool in Cartesian space", async () => {
  const p0 = await page.evaluate(() => app.c.position());
  await page.keyboard.down("w"); await page.waitForTimeout(500); await page.keyboard.up("w");
  await page.keyboard.down("r"); await page.waitForTimeout(300); await page.keyboard.up("r");
  await waitArm(page);
  const p1 = await page.evaluate(() => app.c.position());
  assert(p1[0] > p0[0] + 5 && p1[2] > p0[2] + 3 && Math.abs(p1[1] - p0[1]) < 0.5, `${p0} -> ${p1}`);
  return `(${p0.map((v) => v.toFixed(1))}) -> (${p1.map((v) => v.toFixed(1))})`;
});

await check("T target prompt (IK) reaches 200, 50, 60", async () => {
  await page.keyboard.press("t");
  await page.locator("#prompt-input").fill("200, 50, 60");
  await shot(page, "02_target_prompt.png");
  await page.keyboard.press("Enter");
  await waitArm(page);
  const p = await page.evaluate(() => app.c.position());
  assert(Math.hypot(p[0] - 200, p[1] - 50, p[2] - 60) < 0.1, "pos " + p);
  await page.keyboard.press("t");
  await page.locator("#prompt-input").fill("600, 0, 50");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const toast = await page.evaluate(() => app.lastToast);
  assert(/reach/i.test(toast), "no unreachable toast: " + toast);
  await shot(page, "03_unreachable_toast.png");
  return `unreachable toast: "${toast}"`;
});

await check("help (F1) opens and closes", async () => {
  await page.keyboard.press("F1");
  assert(await page.locator("#help").isVisible(), "help hidden");
  await shot(page, "04_help.png");
  await page.keyboard.press("Escape");
  assert(!(await page.locator("#help").isVisible()), "help still open");
});

await check("all 8 class samples run to completion via the Examples menu (10x)", async () => {
  await page.locator('#sim-seg [data-arg="10"]').click();
  const out = [];
  for (const [file, exp] of Object.entries(expected)) {
    const rc = await page.evaluate(() => app.host.runCount || 0);
    await page.selectOption("#examples", file);
    await page.waitForFunction((n) => app.host.runCount > n, rc, { timeout: 60000 });
    await waitIdle(page, 180000);
    const r = await page.evaluate(() => ({ state: app.host.state, err: app.host.error, pos: app.c.position(), tool: app.c.toolType, moves: app.host.moveLog.length }));
    const d = Math.hypot(...r.pos.map((v, i) => v - exp.position[i]));
    out.push(`${file.replace(".ctepython", "")}: ${r.state}, ${d.toFixed(3)} mm, ${r.moves} moves`);
    assert(r.state === "finished", `${file}: ${r.state} ${r.err}`);
    assert(d < 1.0, `${file}: final position ${r.pos} vs ${exp.position}`);
    assert(r.moves === exp.moves, `${file}: ${r.moves} moves vs ${exp.moves}`);
    assert(r.tool === exp.tool, `${file}: tool ${r.tool} vs ${exp.tool}`);
    const slug = file.replace(/\.ctepython$/, "").replace(/[^A-Za-z0-9]+/g, "_");
    if (["1_1_4_Hopscotch", "1_1_6_Initials", "1_3_1"].includes(slug)) await shot(page, `05_sample_${slug}.png`);
  }
  assert(page.errors.length === 0, page.errors.join(" | "));
  return "\n    " + out.join("\n    ");
});

await check("pen drawing exists after Initials and Clear drawing removes it", async () => {
  const rc = await page.evaluate(() => app.host.runCount || 0);
  await page.selectOption("#examples", "1.1.6 Initials.ctepython");
  await page.waitForFunction((n) => app.host.runCount > n, rc, { timeout: 30000 });
  await waitIdle(page);
  const n = await page.evaluate(() => app.trail.filter(Boolean).length);
  assert(n > 50, "pen trail points " + n);
  await page.locator("#btn-clear-drawing").click();
  const n2 = await page.evaluate(() => app.trail.filter(Boolean).length);
  assert(n2 === 0, "trail not cleared");
  return `${n} pen points`;
});

await check("export is byte-identical for all 8 samples (UI Export button + exportData)", async () => {
  await page.evaluate(() => app.toggleEditor(true));
  for (const file of Object.keys(expected)) {
    await page.evaluate((f) => app.openExample(f, { run: false }), file);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator('[data-action="editor_export"]').click()]);
    const got = fs.readFileSync(await dl.path());
    const orig = fs.readFileSync(path.join(SITE, "examples", file));
    assert(got.equals(orig), `${file}: export differs (${got.length} vs ${orig.length} bytes)`);
    assert(dl.suggestedFilename() === file, "file name " + dl.suggestedFilename());
    const [, saveText] = await page.evaluate(() => app.saveData());
    assert(Buffer.from(saveText, "utf8").equals(orig), `${file}: Save differs`);
  }
  await shot(page, "06_editor_open.png");
});

await check("load a project from the computer (file input) and run it", async () => {
  const src = "from cte import *\narm = Arm()\nbrain = Brain()\nbrain.screen.print('hello from file')\narm.move_to(150, 20, 80)\n";
  const rc = await page.evaluate(() => app.host.runCount || 0);
  await page.locator("#file-project").setInputFiles({ name: "mine.py", mimeType: "text/x-python", buffer: Buffer.from(src) });
  await page.waitForFunction((n) => app.host.runCount > n && app.host.state === "finished", rc, { timeout: 60000 });
  await waitArm(page);
  const r = await page.evaluate(() => ({ name: app.host.projectName, pos: app.c.position(), screen: app.host.screen.visible(5).join("\n"), ed: app.editor.text }));
  assert(Math.hypot(r.pos[0] - 150, r.pos[1] - 20, r.pos[2] - 80) < 0.1, "pos " + r.pos);
  assert(r.screen.includes("hello from file"), "screen: " + r.screen);
  assert(r.ed === src, "editor text differs");
  return r.name;
});

await check("threads, wait(), brain screen and signal tower; pause / step / stop", async () => {
  const code = [
    "from cte import *", "arm = Arm()", "brain = Brain()", "signal_tower = arm.signal_tower", "",
    "def blinker():", "    for i in range(3):", "        signal_tower.set_color(SignalTower.GREEN, SignalTower.ON)", "        wait(100, MSEC)", "",
    "cte_thread(blinker)", "brain.screen.print('thread started')", "brain.screen.next_row()",
    "n = 0", "while True:", "    n = n + 1", "    brain.screen.print(n)", "    brain.screen.next_row()", "    wait(200, MSEC)", "",
  ].join("\n");
  await page.evaluate((c) => { app.editor.open(c, { name: "loop.py" }); app.host.setSpeed(1); }, code);
  await page.locator('[data-action="editor_run"]').click();
  await page.waitForFunction(() => app.host.screen.visible(20).join(" ").includes("3"), null, { timeout: 60000 });
  const tower = await page.evaluate(() => JSON.stringify(app.host.tower));
  assert(/GREEN/i.test(tower), "tower " + tower);
  await page.locator("#btn-pause").click();
  await page.waitForFunction(() => app.host.paused && app.host.currentLine > 0, null, { timeout: 10000 });
  const l0 = await page.evaluate(() => app.host.currentLine);
  await page.locator("#btn-step-line").click();
  await page.waitForFunction((l) => app.host.currentLine !== l, l0, { timeout: 10000 });
  const l1 = await page.evaluate(() => app.host.currentLine);
  await shot(page, "07_paused_step.png");
  await page.locator("#btn-stop").click();
  await page.waitForFunction(() => !app.host.running, null, { timeout: 5000 });
  const st = await page.evaluate(() => app.host.state);
  assert(st === "stopped", "state " + st);
  return `tower ${tower}; step line ${l0} -> ${l1}; stopped`;
});

await check("Step move from idle: starts paused, each click runs to the next arm command", async () => {
  await page.evaluate(() => app.editor.open("from cte import *\narm = Arm()\nx = 1\ny = 2\narm.move_to(150, 0, 80)\nz = 3\narm.move_to(170, 0, 80)\n", { name: "steps.py" }));
  await page.locator("#btn-step-move").click();
  await page.waitForFunction(() => app.host.paused && app.host.currentLine > 0, null, { timeout: 30000 });
  const seen = [await page.evaluate(() => app.host.currentLine)];
  for (let i = 0; i < 2; i++) {
    await page.locator("#btn-step-move").click();
    await page.waitForFunction((l) => app.host.currentLine !== l && app.c.isDone(), seen.at(-1), { timeout: 15000 });
    seen.push(await page.evaluate(() => app.host.currentLine));
  }
  assert(seen.join(",") === "1,5,7", "lines " + seen);
  await page.locator("#btn-step-move").click();
  await page.waitForFunction(() => app.host.state === "finished" && app.c.isDone(), null, { timeout: 15000 });
  const p = await page.evaluate(() => app.c.position());
  assert(Math.hypot(p[0] - 170, p[2] - 80) < 0.1, "pos " + p);
  return "paused at lines " + seen.join(" -> ") + " -> finished";
});

await check("Python errors show the line number", async () => {
  await page.evaluate(() => app.editor.open("from cte import *\narm = Arm()\nx = 1\ny = x / 0\n", { name: "err.py" }));
  await page.locator('[data-action="editor_run"]').click();
  await page.waitForFunction(() => app.host.state === "error", null, { timeout: 30000 });
  const r = await page.evaluate(() => ({ e: app.host.error, l: app.host.errorLine, vis: !document.querySelector("#prog-error").hidden }));
  assert(r.l === 4 && /ZeroDivision/.test(r.e) && r.vis, JSON.stringify(r));
  await shot(page, "08_python_error.png");
  await page.evaluate(() => app.toggleEditor(false));
  return `line ${r.l}: ${r.e.split("\n").at(-1)}`;
});

await check("Add model menu: bundled models, cube, disk", async () => {
  await page.evaluate(() => app.clearObjects());
  await page.locator("#btn-add").click();
  await page.waitForSelector('#library .it[data-name="test_pallet.3mf"], #library .it >> text=pallet', { timeout: 10000 });
  await shot(page, "09_add_model_menu.png");
  const names = await page.$$eval("#library .it", (els) => els.map((e) => e.dataset.name));
  await page.locator('#library .it[data-name="Cube"]').click();
  await page.locator("#btn-add").click();
  const pallet = names.find((n) => /pallet/i.test(n));
  await page.locator(`#library .it[data-name="${pallet}"]`).click();
  await page.waitForFunction(() => app.models.length === 1, null, { timeout: 10000 });
  const sz = await page.evaluate(() => app.models[0].size().map((v) => Math.round(v)));
  assert(sz.join(",") === "90,60,14", "pallet size " + sz);
  return `menu: ${names.join(", ")}; pallet ${sz.join("×")} mm`;
});

await check("import an STL from the computer (IndexedDB) and place mode", async () => {
  const stl = fs.readFileSync(path.join(SITE, "models/test_cylinder.stl"));
  await page.locator("#file-model").setInputFiles({ name: "my_part.stl", mimeType: "model/stl", buffer: stl });
  await page.waitForFunction(() => app.models.some((m) => m.name.startsWith("my_part")), null, { timeout: 10000 });
  const stored = await page.evaluate(async () => { await app.library.refresh(); return app.library.stored.map((s) => s.name); });
  assert(stored.includes("my_part.stl"), "not stored: " + stored);
  const n0 = await page.evaluate(() => app.c.objects.length);
  await page.keyboard.press("p");
  const pt = await page.evaluate(() => app.renderer.project([210, 190, 0]));   // Tile location 35-ish, front-left of the arm
  await page.locator("#c3d").click({ position: { x: pt[0], y: pt[1] } });
  await page.waitForFunction((n) => app.c.objects.length === n + 1, n0, { timeout: 5000 });
  await page.keyboard.press("Escape");
  const ob = await page.evaluate(() => app.c.objects.at(-1).pos);
  assert(Math.hypot(ob[0] - 210, ob[1] - 190) < 3, "placed at " + ob);
  await shot(page, "10_imported_models.png");
  return `stored: ${stored.join(", ")}; placed cube at ${ob.map((v) => v.toFixed(0))}`;
});

// --------------------------------------------------------------- file import routing
const toasts = () => page.$$eval("#toasts .toast", (els) => els.map((e) => e.textContent));
const modelNames = () => page.evaluate(() => app.models.map((m) => m.name));
const pick = (input, name, buffer, mimeType = "application/octet-stream") => page.locator(input).setInputFiles({ name, mimeType, buffer: Buffer.from(buffer) });
const waitModel = (prefix) => page.waitForFunction((p) => app.models.some((m) => m.name.startsWith(p)), prefix, { timeout: 15000 });
const modelInfo = (prefix) => page.evaluate((p) => { const m = app.models.find((x) => x.name.startsWith(p)); return { name: m.name, fmt: m.fmt, size: m.size().map((v) => Math.round(v * 10) / 10), notes: m.notes, autoScale: m.autoScale, offset: m.offset.map(Math.round) }; }, prefix);

await check("Scene section: 'Import model…', 'Save scene', 'Load scene' buttons and a broad model accept list", async () => {
  const b = await page.evaluate(() => ({
    imp: document.querySelector("#btn-import")?.textContent.trim(), impTitle: document.querySelector("#btn-import")?.title,
    save: document.querySelector("#btn-scene-save")?.textContent.trim(), saveTitle: document.querySelector("#btn-scene-save")?.title,
    load: document.querySelector("#btn-scene-load")?.textContent.trim(), loadTitle: document.querySelector("#btn-scene-load")?.title,
    accept: document.querySelector("#file-model").accept,
  }));
  assert(b.imp === "Import model…" && /STL \/ 3MF/.test(b.impTitle), JSON.stringify(b));
  assert(b.save === "Save scene" && b.saveTitle === "Save the platform and objects as a .json scene file", JSON.stringify(b));
  assert(b.load === "Load scene" && b.loadTitle === "Open a saved .json scene file", JSON.stringify(b));
  for (const t of [".stl", ".3mf", "model/stl", "model/3mf", "application/sla", "application/octet-stream"]) assert(b.accept.includes(t), "accept lacks " + t);
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.locator("#btn-import").click()]);
  const id = await fc.element().getAttribute("id");
  assert(id === "file-model", "Import model… opened #" + id);
  const [fc2] = await Promise.all([page.waitForEvent("filechooser"), page.locator("#btn-scene-load").click()]);
  assert((await fc2.element().getAttribute("id")) === "file-scene", "Load scene opened the wrong input");
  await page.evaluate(() => document.querySelector("#panel").scrollTop = 0);
  return `${b.imp} | ${b.save} | ${b.load}`;
});

await check("model picker: ASCII STL", async () => {
  await pick("#file-model", "ascii_cube.stl", asciiSTL(cube(25)), "model/stl");
  await waitModel("ascii_cube");
  const m = await modelInfo("ascii_cube");
  assert(m.fmt === "STL" && m.size.join(",") === "25,25,25", JSON.stringify(m));
  assert(m.offset[2] === 0, "not on the floor " + m.offset);
  return `${m.name} ${m.size.join("×")} mm at (${m.offset})`;
});

await check("model picker: binary STL whose header starts with 'solid'", async () => {
  await pick("#file-model", "solid_header.stl", binarySTL(cube(30), "solid header from a CAD export"), "application/sla");
  await waitModel("solid_header");
  const m = await modelInfo("solid_header");
  assert(m.size.join(",") === "30,30,30", JSON.stringify(m));
  return `${m.name} ${m.size.join("×")} mm`;
});

const prod3mf = production3MF({
  parts: [{ tris: cube(10), name: "small" }, { tris: cube(20), name: "big", componentTransform: translate(0, 0, 5) }, { tris: cube(5) }],
  build: [{ part: 0 }, { part: 1, transform: translate(50, 0, 0) }, { part: 2, transform: translate(0, 40, 0) }],
});

await check("model picker: multi-object 3MF with the production extension (Bambu / PrusaSlicer layout)", async () => {
  await pick("#file-model", "bambu_plate.3mf", prod3mf, "application/vnd.ms-package.3dmanufacturing-3dmodel+xml");
  await waitModel("bambu_plate");
  const m = await modelInfo("bambu_plate");
  assert(m.fmt === "3MF" && m.size.join(",") === "70,45,25", JSON.stringify(m));
  assert(m.notes.some((n) => /3 objects/.test(n)), "notes " + m.notes);
  const toast = await page.evaluate(() => app.lastToast);
  assert(/Added bambu_plate.*3 objects combined/.test(toast), toast);
  return `${m.size.join("×")} mm; "${toast}"`;
});

await check("Load scene picker given an STL imports it as a model and says so", async () => {
  const n0 = (await modelNames()).length;
  await pick("#file-scene", "via_scene_picker.stl", fs.readFileSync(path.join(SITE, "models/test_cube.stl")), "model/stl");
  await waitModel("via_scene_picker");
  const t = await toasts();
  assert((await modelNames()).length === n0 + 1, "model count");
  assert(t.some((x) => /via_scene_picker\.stl is a 3D model, not a scene file - importing it as a model/.test(x)), "toasts: " + t.join(" | "));
  assert(t.some((x) => /^Added via_scene_picker/.test(x)), "toasts: " + t.join(" | "));
  return t.join(" | ");
});

await check("Load… project picker given a 3MF imports it as a model", async () => {
  const rc = await page.evaluate(() => app.host.runCount || 0);
  await pick("#file-project", "via_project_picker.3mf", prod3mf);
  await waitModel("via_project_picker");
  const m = await modelInfo("via_project_picker");
  const t = await toasts();
  assert(m.size.join(",") === "70,45,25", JSON.stringify(m));
  assert(t.some((x) => /is a 3D model, not a program/.test(x)), "toasts: " + t.join(" | "));
  assert((await page.evaluate(() => app.host.runCount || 0)) === rc, "a program was started");
  return `${m.name} ${m.size.join("×")} mm`;
});

await check("Import model picker given a scene .json loads the scene", async () => {
  const before = await page.evaluate(() => ({ n: app.c.objects.length + app.models.length, names: [...app.c.objects.map((o) => o.name), ...app.models.map((m) => m.name)].sort() }));
  const json = await page.evaluate(() => app.sceneJSON());
  await page.evaluate(() => app.clearObjects());
  await page.waitForFunction(() => app.c.objects.length === 0 && app.models.length === 0);
  await pick("#file-model", "my_scene.json", json, "application/json");
  await page.waitForFunction((n) => app.c.objects.length + app.models.length === n, before.n, { timeout: 15000 });
  const after = await page.evaluate(() => [...app.c.objects.map((o) => o.name), ...app.models.map((m) => m.name)].sort());
  const t = await toasts();
  assert(JSON.stringify(after) === JSON.stringify(before.names), JSON.stringify({ before: before.names, after }));
  assert(t.some((x) => /my_scene\.json is a scene file, not a 3D model - loading it as a scene/.test(x)), "toasts: " + t.join(" | "));
  return `${after.length} items back: ${after.join(", ")}`;
});

await check("drag and drop onto the 3D view: overlay, then a model and a program", async () => {
  const n0 = (await modelNames()).length;
  const rc = await page.evaluate(() => app.host.runCount || 0);
  const src = "from cte import *\narm = Arm()\narm.move_to(160, 30, 90)\n";
  const files = [
    { name: "dropped.stl", type: "", bytes: [...binarySTL(cube(15))] },
    { name: "dropped.py", type: "text/x-python", bytes: [...Buffer.from(src)] },
  ];
  const r = await page.evaluate(({ files }) => {
    const dt = (window.__dt = new DataTransfer());
    for (const f of files) dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
    const cv = document.querySelector("#c3d");
    const ev = (type) => new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
    cv.dispatchEvent(ev("dragenter"));
    cv.dispatchEvent(ev("dragover"));
    window.__dragTimer = setInterval(() => cv.dispatchEvent(ev("dragover")), 100);   // a real drag keeps firing dragover
    return { overlayShown: !document.querySelector("#drop-overlay").hidden, overlayText: document.querySelector("#drop-overlay").textContent, types: [...dt.types] };
  }, { files });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, "10a_drop_overlay.png") });
  r.overlayAfterDrop = await page.evaluate(() => {
    clearInterval(window.__dragTimer);
    document.querySelector("#c3d").dispatchEvent(new DragEvent("drop", { dataTransfer: window.__dt, bubbles: true, cancelable: true }));
    return !document.querySelector("#drop-overlay").hidden;
  });
  assert(r.overlayShown && !r.overlayAfterDrop, JSON.stringify(r));
  assert(/Drop to open/.test(r.overlayText) && /STL/.test(r.overlayText) && /\.json/.test(r.overlayText), r.overlayText);
  await waitModel("dropped");
  await page.waitForFunction((n) => app.host.runCount > n && app.host.state === "finished", rc, { timeout: 60000 });
  await waitArm(page);
  const m = await modelInfo("dropped");
  const p = await page.evaluate(() => app.c.position());
  assert((await modelNames()).length === n0 + 1 && m.size.join(",") === "15,15,15", JSON.stringify(m));
  assert(Math.hypot(p[0] - 160, p[1] - 30, p[2] - 90) < 0.1, "program did not run: " + p);
  return `overlay "${r.overlayText.trim().replace(/\s+/g, " ")}"; ${m.name} ${m.size.join("×")} mm; program ran -> (${p.map((v) => v.toFixed(0))})`;
});

await check("a model saved in meters is scaled x1000 with a notice; a huge one is scaled down", async () => {
  await pick("#file-model", "meters.stl", binarySTL(cube(0.025)));
  await waitModel("meters");
  const m = await modelInfo("meters");
  assert(m.size.join(",") === "25,25,25" && m.autoScale === 1000, JSON.stringify(m));
  const t1 = await page.evaluate(() => app.lastToast);
  assert(/scaled x1000.*meters/.test(t1), t1);
  await pick("#file-model", "huge.stl", binarySTL(cube(1200)));
  await waitModel("huge");
  const hm = await modelInfo("huge");
  assert(hm.size.join(",") === "400,400,400" && Math.abs(hm.autoScale - 1 / 3) < 1e-6, JSON.stringify(hm));
  const t2 = (await toasts()).find((x) => /^Added huge/.test(x)) || "";   // a 400 mm cube also triggers a collision toast
  assert(/scaled down to 400 mm - the file was 1200 mm across/.test(t2), t2);
  await page.evaluate(() => { for (const n of ["huge", "meters"]) { const m = app.models.find((x) => x.name.startsWith(n)); if (m) app.removeObject(m); } });
  return `"${t1}" / "${t2}"`;
});

await check("unknown and broken files get a friendly error", async () => {
  const n0 = (await modelNames()).length;
  await pick("#file-model", "photo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), "image/png");
  await page.waitForFunction(() => /Can't open photo\.png/.test(app.lastToast), null, { timeout: 5000 });
  const t1 = await page.evaluate(() => app.lastToast);
  assert(/models \(\.stl, \.3mf\), scenes \(\.json\) and programs/.test(t1), t1);
  await pick("#file-model", "broken.stl", Buffer.from("this is not an stl at all, just text"), "model/stl");
  await page.waitForFunction(() => /broken\.stl/.test(app.lastToast), null, { timeout: 5000 });
  const t2 = await page.evaluate(() => app.lastToast);
  assert(/Could not import broken\.stl.*not an STL/.test(t2), t2);
  assert((await modelNames()).length === n0, "something was added");
  await shot(page, "10b_import_errors.png");
  return `"${t1}" / "${t2}"`;
});

await check("3MF import survives a scene save / load round trip (embedded) and the model list shows the type", async () => {
  const row = await page.evaluate(() => { const el = [...document.querySelectorAll("#scene-list .obj")].find((e) => e.dataset.name.startsWith("bambu_plate")); return el && el.querySelector(".ty").textContent; });
  assert(row === "3MF", "type column " + row);
  await page.evaluate(() => { for (const m of [...app.models]) if (!/bambu_plate|my_part/.test(m.name)) app.removeObject(m); });
  return "ok";
});

await check("drag an object, undo and redo", async () => {
  const ob0 = await page.evaluate(() => { const o = app.c.objects.at(-1); return { name: o.name, pos: [...o.pos] }; });
  const a = await page.evaluate((p) => app.renderer.project([p[0], p[1], 20]), ob0.pos);
  const b = await page.evaluate((p) => app.renderer.project([p[0] - 60, p[1] + 40, 20]), ob0.pos);
  await page.mouse.move(a[0] + (await page.locator("#c3d").boundingBox()).x, a[1] + (await page.locator("#c3d").boundingBox()).y);
  const box = await page.locator("#c3d").boundingBox();
  await page.mouse.move(box.x + a[0], box.y + a[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + b[0], box.y + b[1], { steps: 8 });
  await page.mouse.up();
  const p1 = await page.evaluate((n) => app.c.objects.find((o) => o.name === n).pos, ob0.name);
  assert(Math.hypot(p1[0] - ob0.pos[0], p1[1] - ob0.pos[1]) > 30, `not dragged ${ob0.pos} -> ${p1}`);
  await page.keyboard.press("Control+z");
  const p2 = await page.evaluate((n) => app.c.objects.find((o) => o.name === n).pos, ob0.name);
  assert(Math.hypot(p2[0] - ob0.pos[0], p2[1] - ob0.pos[1]) < 0.01, "undo failed " + p2);
  await page.keyboard.press("Control+y");
  const p3 = await page.evaluate((n) => app.c.objects.find((o) => o.name === n).pos, ob0.name);
  assert(Math.hypot(p3[0] - p1[0], p3[1] - p1[1]) < 0.01, "redo failed " + p3);
  return `${ob0.name}: (${ob0.pos.slice(0, 2).map(Math.round)}) -> (${p1.slice(0, 2).map(Math.round)})`;
});

await check("scene save / load round trip (download + upload)", async () => {
  const before = await page.evaluate(() => ({ objs: app.c.objects.map((o) => o.name + ":" + o.pos.map(Math.round)), models: app.models.map((m) => m.name + ":" + m.offset.map(Math.round)) }));
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator('[data-action="scene_save"]').click()]);
  const text = fs.readFileSync(await dl.path(), "utf8");
  const data = JSON.parse(text);
  assert(data.format === "six-axis-arm-scene", "format " + data.format);
  await page.evaluate(() => app.clearObjects());
  await page.waitForFunction(() => app.c.objects.length === 0 && app.models.length === 0);
  await page.locator("#file-scene").setInputFiles({ name: dl.suggestedFilename(), mimeType: "application/json", buffer: Buffer.from(text) });
  await page.waitForFunction((n) => app.c.objects.length + app.models.length === n, before.objs.length + before.models.length, { timeout: 10000 });
  const after = await page.evaluate(() => ({ objs: app.c.objects.map((o) => o.name + ":" + o.pos.map(Math.round)), models: app.models.map((m) => m.name + ":" + m.offset.map(Math.round)) }));
  assert(JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }));
  return `${dl.suggestedFilename()} (${text.length} bytes): ${[...after.objs, ...after.models].join(", ")}`;
});

await check("autosave restores the scene after a reload", async () => {
  const before = await page.evaluate(() => app.c.objects.length + app.models.length);
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForFunction(() => window.app && window.app.frames > 5);
  await page.evaluate(() => app.ready);
  const after = await page.evaluate(() => app.c.objects.length + app.models.length);
  assert(after === before, `${before} -> ${after}`);
  return `${after} items`;
});

await check("platform presets and typed size", async () => {
  await page.locator('[data-sec="platform"] .sec-head').click();
  const btn = page.locator("#presets button").first();
  await btn.click();
  const s1 = await page.evaluate(() => app.c.platform.size);
  await page.locator("#plat-w").fill("500");
  await page.keyboard.press("Enter");
  const s2 = await page.evaluate(() => app.c.platform.size);
  assert(s2[0] === 500, "width " + s2);
  await shot(page, "11_platform.png");
  await page.locator('[data-action="platform_reset"]').click();
  return `preset -> ${s1.join("×")}, typed -> ${s2.join("×")}`;
});

await check("reach map, path trail and collision warning", async () => {
  await page.locator('[data-sec="overlays"] .sec-head').click();
  await page.locator("#sw-reach").click();
  await page.locator("#sw-path").click();
  await page.waitForFunction(() => app.reach.ready ?? !app.reach.busy, null, { timeout: 30000 });
  await page.evaluate(() => { app.clearObjects(); app.resetObjects(); });   // just the cubes and the disk
  const go = async (t) => {
    await page.keyboard.press("t"); await page.locator("#prompt-input").fill(t); await page.keyboard.press("Enter");
    await waitArm(page); await page.waitForTimeout(300);
    return page.evaluate(() => ({ pos: app.c.position().map(Math.round), hits: app.hits.map((h) => h.join(" > ")), toast: app.lastToast }));
  };
  await go("150, 105, 15");
  const stopped = await go("150, 135, 10");            // into the blue cube on location 29 (150, 150): "Jogs" stop is on by default
  assert(/Stopped before a collision.*Blue cube/.test(stopped.toast), "no stop: " + JSON.stringify(stopped));
  await page.locator("#cs-manual").click();             // turn the stop off -> it only warns
  const warned = await go("150, 135, 10");
  assert(warned.hits.some((h) => h.includes("Blue cube")), "no warning: " + JSON.stringify(warned));
  const r = await page.evaluate(() => ({ reach: app.showReach, path: app.pathTrail.length }));
  await shot(page, "12_reach_path_collision.png");
  await page.locator("#cs-manual").click();
  assert(r.reach && r.path > 5, JSON.stringify(r));
  return `stop: "${stopped.toast}" at (${stopped.pos}); warn only: ${warned.hits.join(", ")}; trail ${r.path} pts`;
});

await check("collapsing sections works and is remembered", async () => {
  await page.evaluate(() => app.goHome && app.goHome());
  for (const s of ["joints", "tool", "scene"]) await page.locator(`[data-sec="${s}"] > .sec-head, [data-sec="${s}"] .sec-head-row > .sec-head`).first().click();
  const col = await page.$$eval("[data-sec]", (els) => Object.fromEntries(els.map((e) => [e.dataset.sec, e.classList.contains("collapsed")])));
  assert(col.joints && col.tool && col.scene, JSON.stringify(col));
  await shot(page, "13_sections_collapsed.png");
  await page.reload();
  await page.waitForFunction(() => window.app && window.app.frames > 5);
  const col2 = await page.$$eval("[data-sec]", (els) => Object.fromEntries(els.map((e) => [e.dataset.sec, e.classList.contains("collapsed")])));
  assert(col2.joints && col2.tool && col2.scene, "not remembered " + JSON.stringify(col2));
  for (const s of ["joints", "tool", "scene"]) await page.locator(`[data-sec="${s}"] > .sec-head, [data-sec="${s}"] .sec-head-row > .sec-head`).first().click();
  for (const s of ["platform", "overlays"]) if (col2[s]) {/* leave */}
  return JSON.stringify(col);
});

await check("no console errors during the whole desktop session", async () => {
  assert(page.errors.length === 0, page.errors.join(" | "));
});

// --------------------------------------------------------------- small screens
for (const [label, vp, file] of [["phone 390x844", { width: 390, height: 844 }, "14_mobile.png"], ["small window 1000x700", { width: 1000, height: 700 }, "15_small_window.png"]]) {
  await check(`layout: ${label}`, async () => {
    const p = await openPage(vp);
    const m = await p.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return { sw: document.documentElement.scrollWidth, iw: innerWidth, view: r("#view"), panel: r("#panel"), top: r("#topbar"), canvas: r("#c3d") };
    });
    assert(m.sw <= m.iw + 1, `horizontal overflow ${m.sw} > ${m.iw}`);
    assert(m.view.width >= vp.width * 0.5 && m.view.height > 250, "view too small " + JSON.stringify(m.view));
    assert(m.top.right <= m.iw + 1, "top bar overflows");
    assert(m.panel.width > 250, "panel " + JSON.stringify(m.panel));
    await p.screenshot({ path: path.join(SHOTS, file) });
    if (vp.width < 500) { await p.evaluate(() => app.toggleEditor(true)); await p.screenshot({ path: path.join(SHOTS, "14b_mobile_editor.png"), fullPage: true }); }
    assert(p.errors.length === 0, p.errors.join(" | "));
    await p.context().close();
    return `view ${Math.round(m.view.width)}×${Math.round(m.view.height)}, panel ${Math.round(m.panel.width)}×${Math.round(m.panel.height)}`;
  });
}

// --------------------------------------------------------------- Pyodide blocked
await check("friendly message when the Python CDN is blocked", async () => {
  const p = await openPage(undefined, (ctx) => ctx.route(/cdn\.jsdelivr\.net/, (r) => r.abort()));
  await p.evaluate(() => app.openExample("1.1.5 Marker.ctepython"));
  await p.waitForSelector("#py-banner:not([hidden])", { timeout: 30000 });
  await p.waitForFunction(() => app.host.pyStatus === "error", null, { timeout: 30000 });
  const t = await p.locator("#py-banner").innerText();
  assert(/python/i.test(t) && /settings\.js|network|school/i.test(t), t);
  await p.screenshot({ path: path.join(SHOTS, "16_python_blocked.png") });
  // the rest of the app still works
  await p.keyboard.press("t"); await p.locator("#prompt-input").fill("180, 0, 60"); await p.keyboard.press("Enter");
  await p.waitForFunction(() => app.c.isDone());
  const pos = await p.evaluate(() => app.c.position());
  assert(Math.abs(pos[0] - 180) < 0.1, "arm stuck");
  await p.context().close();
  return JSON.stringify(t.replace(/\s+/g, " ").slice(0, 160));
});

await browser.close();
const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
