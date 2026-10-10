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

await check("Examples menu lists the bundled examples with titles and descriptions", async () => {
  const index = JSON.parse(fs.readFileSync(path.join(SITE, "examples/index.json"), "utf8")).examples;
  const opts = await page.$$eval("#examples option", (els) => els.slice(1).map((o) => [o.value, o.textContent]));
  assert(opts.length === index.length && opts.length >= 10, `${opts.length} options`);
  for (const [i, e] of index.entries()) assert(opts[i][0] === e.file && opts[i][1] === `${e.name}  (${e.info})`, `option ${i}: ${opts[i]}`);
  assert(!opts.some(([v]) => /Hopscotch|Marker|Initials|1\.2\.3|1\.3\.1|CubesTemplate|PickAndPlace|^Pallet/.test(v)), "old class files still listed");
  return opts.map(([, t]) => t.split("  (")[0]).join(", ");
});

await check("every bundled example runs to completion on the default scene (10x): no unreachable moves, no collisions", async () => {
  await page.locator('#sim-seg [data-arg="10"]').click();
  const out = [];
  for (const [file, exp] of Object.entries(expected)) {
    await page.evaluate(() => { app.clearObjects(); app.resetObjects(); app.collisionLog = []; if (app.c.magnetOn) app.c.setMagnet(false); app.setTool("MAGNET"); app.c.speedPercent = 50; });
    const rc = await page.evaluate(() => app.host.runCount || 0);
    await page.selectOption("#examples", file);
    await page.waitForFunction((n) => app.host.runCount > n, rc, { timeout: 60000 });
    await waitIdle(page, 180000);
    const r = await page.evaluate(() => ({ state: app.host.state, err: app.host.error, pos: app.c.position(), tool: app.c.toolType, moves: app.host.moveLog.length,
      failed: app.host.moveLog.filter((m) => !m[2]).map((m) => m.slice(0, 2).join(" ")), collisions: app.collisionLog || [], notes: app.host.screen.notes.filter((n) => /ERROR|can't/.test(n)) }));
    const d = Math.hypot(...r.pos.map((v, i) => v - exp.position[i]));
    out.push(`${file.replace(".ctepython", "")}: ${r.state}, ${d.toFixed(3)} mm, ${r.moves} moves`);
    assert(r.state === "finished", `${file}: ${r.state} ${r.err}`);
    assert(d < 1.0, `${file}: final position ${r.pos} vs ${exp.position}`);
    assert(r.moves === exp.moves, `${file}: ${r.moves} moves vs ${exp.moves}`);
    assert(r.tool === exp.tool, `${file}: tool ${r.tool} vs ${exp.tool}`);
    assert(r.failed.length === 0 && r.notes.length === 0, `${file}: failed moves ${r.failed.join("; ")} ${r.notes.join("; ")}`);
    assert(r.collisions.length === 0, `${file}: collisions ${r.collisions.join("; ")}`);
    const slug = file.replace(/\.ctepython$/, "").replace(/[^A-Za-z0-9]+/g, "_");
    if (/Pen_Square|Stack_Cubes|Functions/.test(slug)) await shot(page, `05_example_${slug}.png`);
  }
  // Stack Cubes really stacked them, Pick and Place really moved the red cube
  const stacked = await page.evaluate(() => { app.clearObjects(); app.resetObjects(); return app.c.objects.map((o) => o.name + "@" + o.pos.map(Math.round)); });
  assert(stacked.join(" ") === "Red cube@150,50,0 Blue cube@150,150,0 Green disk@50,200,0", "scene reset: " + stacked);
  assert(page.errors.length === 0, page.errors.join(" | "));
  return "\n    " + out.join("\n    ");
});

await check("Stack Cubes leaves the red cube on the blue cube; Pick and Place moves it to square 33", async () => {
  const runFile = async (f) => {
    await page.evaluate(() => { app.clearObjects(); app.resetObjects(); });
    const rc = await page.evaluate(() => app.host.runCount || 0);
    await page.selectOption("#examples", f);
    await page.waitForFunction((n) => app.host.runCount > n, rc, { timeout: 30000 });
    await waitIdle(page);
    return page.evaluate(() => Object.fromEntries(app.c.objects.map((o) => [o.name, o.pos.map(Math.round)])));
  };
  const a = await runFile("05 Stack Cubes.ctepython");
  assert(a["Red cube"].join(",") === "150,150,25" && a["Blue cube"].join(",") === "150,150,0", "stack: " + JSON.stringify(a));
  const b = await runFile("04 Pick and Place Basics.ctepython");
  assert(b["Red cube"].join(",") === "200,50,0", "pick and place: " + JSON.stringify(b));
  return `stacked at ${a["Red cube"]}, placed at ${b["Red cube"]}`;
});

await check("Pen Square draws (pen trail) and Clear drawing removes it", async () => {
  await page.evaluate(() => { app.clearObjects(); app.resetObjects(); app.clearDrawing(); });
  const rc = await page.evaluate(() => app.host.runCount || 0);
  await page.selectOption("#examples", "03 Pen Square.ctepython");
  await page.waitForFunction((n) => app.host.runCount > n, rc, { timeout: 30000 });
  await waitIdle(page);
  const r = await page.evaluate(() => ({ n: app.trail.filter(Boolean).length, strokes: app.strokes() }));
  assert(r.n > 50 && r.strokes === 2, "pen trail " + JSON.stringify(r));
  await page.locator("#btn-clear-drawing").click();
  const n2 = await page.evaluate(() => app.trail.filter(Boolean).length);
  assert(n2 === 0, "trail not cleared");
  await page.evaluate(() => app.setTool("MAGNET"));
  return `${r.n} pen points in ${r.strokes} strokes (square + triangle)`;
});

await check("export is byte-identical for every bundled example (UI Export button + Save)", async () => {
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
  return `${Object.keys(expected).length} files`;
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

// --------------------------------------------------------------- moving objects, stacking, magnet
const findBody = (n) => `[...app.c.objects, ...app.models].find((o) => o.name === ${JSON.stringify(n)})`;
const selectBody = (n) => page.evaluate(`app.selectedObject = ${findBody(n)}; app.syncPanel(true);`);
const posOf = (n) => page.evaluate(`(() => { const o = ${findBody(n)}; return (o.offset || o.pos).map((v) => Math.round(v * 10) / 10); })()`);
const canvasBox = () => page.locator("#c3d").boundingBox();
/** Drag the selected object's gizmo arrow by `mm` along `axis` with the mouse. */
const gizmoDrag = async (axis, mm) => {
  const box = await canvasBox();
  const g = await page.evaluate(([axis, mm]) => {
    const c = app.gizmoCenter(app.selectedObject), s = app.renderer._gizmo.s, d = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axis];
    const at = (k) => [c[0] + d[0] * k, c[1] + d[1] * k, c[2] + d[2] * k];
    return { a: app.renderer.project(at(30 * s)), b: app.renderer.project(at(30 * s + mm)) };
  }, [axis, mm]);
  await page.mouse.move(box.x + g.a[0], box.y + g.a[1]);
  await page.waitForTimeout(60);
  const hover = await page.evaluate(() => app.hoverAxis);
  await page.mouse.down();
  await page.mouse.move(box.x + g.b[0], box.y + g.b[1], { steps: 8 });
  await page.mouse.up();
  return hover;
};
const go = async (t) => {
  await page.keyboard.press("t"); await page.locator("#prompt-input").fill(t); await page.keyboard.press("Enter");
  await waitArm(page); await page.waitForTimeout(250);
  return page.evaluate(() => ({ pos: app.c.position().map(Math.round), hits: app.hits.map((h) => h.join(" > ")), toast: app.lastToast }));
};

await check("select an object: move gizmo + position editor; drag the Z and X arrows", async () => {
  await page.evaluate(() => { app.addBuiltin("cube", [150, 50]); app.addBuiltin("cube", [150, 150]); });
  await selectBody("Cube 3");
  await page.evaluate(() => { if (app.snapToSurface) app.doAction("snap"); });            // free Z for this check
  await page.waitForFunction(() => app.renderer.gizmo.visible, null, { timeout: 5000 });   // drawn on the next frame
  const ui = await page.evaluate(() => ({ panel: !document.querySelector("#sel-panel").hidden, name: document.querySelector("#sel-name").textContent,
    x: document.querySelector("#sel-x").value, y: document.querySelector("#sel-y").value, z: document.querySelector("#sel-z").value, gizmo: app.renderer.gizmo.visible, snap: app.snapToSurface }));
  assert(ui.panel && ui.name === "Cube 3" && ui.x === "150" && ui.y === "50" && ui.z === "0" && ui.gizmo && !ui.snap, JSON.stringify(ui));
  const hz = await gizmoDrag("z", 40);
  let p = await posOf("Cube 3");
  assert(hz === "z" && Math.abs(p[2] - 40) < 1.5 && p[0] === 150 && p[1] === 50, `after Z drag ${p} (hover ${hz})`);
  const hx = await gizmoDrag("x", 40);
  p = await posOf("Cube 3");
  assert(hx === "x" && Math.abs(p[0] - 190) < 1.5 && Math.abs(p[2] - 40) < 1.5, `after X drag ${p}`);
  assert(/^Cube 3 moved to \(190, 50, 40\)/.test(await page.evaluate(() => app.lastToast)), await page.evaluate(() => app.lastToast));
  await shot(page, "17_move_gizmo.png");
  return `Z arrow -> z ${p[2]}, X arrow -> x ${p[0]}`;
});

await check("numeric editor, −/+ steppers with step sizes, keyboard nudges; never below the Tile", async () => {
  await page.locator('#step-seg [data-arg="5"]').click();
  await page.locator('#sel-panel [data-action="nudge"][data-arg="y,1"]').click();
  let p = await posOf("Cube 3");
  assert(p.join(",") === "190,55,40", "stepper +Y by 5: " + p);
  await page.locator('#step-seg [data-arg="50"]').click();
  await page.locator('#sel-panel [data-action="nudge"][data-arg="x,-1"]').click();
  p = await posOf("Cube 3");
  assert(p.join(",") === "140,55,40", "stepper -X by 50: " + p);
  await page.locator("#sel-z").fill("-30"); await page.keyboard.press("Enter");
  p = await posOf("Cube 3");
  assert(p.join(",") === "140,55,0", "typed Z = -30 is clamped to the Tile: " + p);
  await page.locator("#c3d").click({ position: { x: 40, y: 400 } });        // keyboard focus back on the page (keeps the selection)
  await selectBody("Cube 3");
  await page.keyboard.press("PageUp"); await page.keyboard.press("PageUp");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  p = await posOf("Cube 3");
  assert(p.join(",") === "140,105,50", "PageUp x2 (+100), Right (+50 Y), Shift+Down (-50 Z): " + p);
  await page.locator('#step-seg [data-arg="10"]').click();
  await page.keyboard.press("ArrowUp"); await page.keyboard.press("ArrowLeft");
  p = await posOf("Cube 3");
  assert(p.join(",") === "150,95,50", "Up / Left by 10: " + p);
  await shot(page, "18_position_editor.png");
  return `(${p}) via steppers, typing and keys`;
});

await check("snap to surface: stacking on another cube, falling off, Drop; block / warn overlaps", async () => {
  await page.locator("#sw-snap").click();
  assert(await page.evaluate(() => app.snapToSurface), "snap not on");
  await page.locator("#btn-drop").click();
  let p = await posOf("Cube 3");
  assert(p.join(",") === "150,95,0", "Drop: " + p);
  await page.locator("#sel-y").fill("150"); await page.keyboard.press("Enter");           // onto Cube 4 at (150, 150)
  p = await posOf("Cube 3");
  assert(p.join(",") === "150,150,25", "climbs onto Cube 4: " + p);
  await page.locator('#sel-panel [data-action="nudge"][data-arg="y,1"]').click();                              // still mostly on top
  p = await posOf("Cube 3");
  assert(p.join(",") === "150,160,25", "nudged on top: " + p);
  await page.locator("#sel-y").fill("200"); await page.keyboard.press("Enter");
  p = await posOf("Cube 3");
  assert(p.join(",") === "150,200,0", "off the edge: falls to the Tile: " + p);
  // overlaps: with snap off, moving into Cube 4 is refused; with Block off it is allowed with a warning
  await page.locator("#sw-snap").click();
  await page.locator("#sel-y").fill("160"); await page.keyboard.press("Enter");
  p = await posOf("Cube 3");
  const t1 = await page.evaluate(() => app.lastToast);
  assert(p.join(",") === "150,200,0" && /Can't move Cube 3 there - it would overlap Cube 4/.test(t1), `${p} ${t1}`);
  await page.locator("#sw-block").click();
  await page.locator("#sel-y").fill("160"); await page.keyboard.press("Enter");
  p = await posOf("Cube 3");
  const t2 = await page.evaluate(() => app.lastToast);
  assert(p.join(",") === "150,160,0" && /Cube 3 at \(150, 160, 0\) - overlaps Cube 4/.test(t2), `${p} ${t2}`);
  await page.locator("#sw-block").click();
  await page.locator("#sel-y").fill("50"); await page.keyboard.press("Enter");
  await page.locator("#sw-snap").click();
  const st = await page.evaluate(() => ({ snap: app.snapToSurface, block: app.blockOverlaps, p: app.c.objects.map((o) => o.name + "@" + o.pos) }));
  assert(st.snap && st.block, JSON.stringify(st));
  return `stacked at z 25, dropped to 0; blocked: "${t1}"; warned: "${t2}"`;
});

await check("undo / redo cover nudges (coalesced), gizmo moves and model rotation", async () => {
  await selectBody("Cube 3");
  const n0 = await page.evaluate(() => app.history.undoStack.length);
  await page.locator("#c3d").click({ position: { x: 40, y: 400 } });
  await selectBody("Cube 3");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowUp");
  let p = await posOf("Cube 3");
  const n1 = await page.evaluate(() => app.history.undoStack.length);
  assert(p[0] === 180 && n1 === n0 + 1, `3 quick nudges = one undo step: x ${p[0]}, stack ${n0} -> ${n1}`);
  await page.keyboard.press("Control+z");
  p = await posOf("Cube 3");
  assert(p[0] === 150, "undo nudges: " + p);
  await page.keyboard.press("Control+y");
  p = await posOf("Cube 3");
  assert(p[0] === 180, "redo nudges: " + p);
  await page.keyboard.press("Control+z");
  await selectBody("bambu_plate.3mf");
  await page.keyboard.press(".");
  await page.locator('#sel-panel [data-action="rotate_axis"][data-arg="z,1"]').click();
  await page.keyboard.press(",");
  const y1 = await page.evaluate(() => app.models.find((m) => m.name === "bambu_plate.3mf").rot[2]);
  assert(y1 === 15, "yaw after . + button + , : " + y1);
  await page.waitForTimeout(1300);                                   // past the coalescing window
  await page.keyboard.press(".");
  await page.keyboard.press("Control+z");
  const y2 = await page.evaluate(() => app.models.find((m) => m.name === "bambu_plate.3mf").rot[2]);
  assert(y2 === 15, "undo the last turn: " + y2);
  const label = await page.evaluate(() => app.lastToast);
  assert(/Undo: Turn bambu_plate/.test(label), label);
  const yawUI = await page.evaluate(() => document.querySelector("#sel-rz").value);
  assert(yawUI === "15", "yaw shown " + yawUI);
  await page.evaluate(() => { app.selectedObject = null; app.syncPanel(true); });
  return `x 150 -> 180 -> 150 -> 180 -> 150; yaw 15° (${label})`;
});

await check("mesh collision: the tool fits in the pallet's slot but stops at its rail", async () => {
  await page.evaluate(async () => { await app.addModel({ library: "models/test_pallet.3mf" }, "test_pallet.3mf", { pos: [60, 120] }); });
  const pal = await page.evaluate(() => { const m = app.models.find((x) => x.name === "test_pallet.3mf"); return { off: m.offset, b: m.worldBounds() }; });
  assert(pal.off.join(",") === "60,120,0", JSON.stringify(pal));
  const slot = await go("60, 120, 9");                       // 3 mm above the 6 mm slot floor, inside the 14 mm box
  assert(/Reached \(60, 120, 9\)/.test(slot.toast) && slot.hits.length === 0, JSON.stringify(slot));
  const rail = await go("60, 98, 9");                        // into the rail
  assert(/Stopped before a collision: tool hits test_pallet.3mf/.test(rail.toast), JSON.stringify(rail));
  await go("60, 98, 40");
  return `slot: "${slot.toast}"; rail: "${rail.toast}"`;
});

await check("magnet picks up a 3MF and an STL from their surfaces, carries them rigidly, releases onto what is below", async () => {
  await page.evaluate(() => { app.c.objects.find((o) => o.name === "Cube 3").pos = [220, 60, 0]; });   // clear the landing area
  // the pallet (3MF): grab it 1 mm above a rail
  const g1 = await go("60, 98, 15");
  await page.keyboard.press("g");
  let held = await page.evaluate(() => ({ held: app.c.held?.body?.name, flag: app.models.find((m) => m.name === "test_pallet.3mf").held, toast: app.lastToast }));
  assert(held.held === "test_pallet.3mf" && held.flag && /Picked up test_pallet/.test(held.toast), JSON.stringify({ g1, held }));
  await go("100, 60, 90");
  const carried = await page.evaluate(() => { const m = app.models.find((x) => x.name === "test_pallet.3mf"); const tip = app.c.position(); return { dz: Math.round(tip[2] - m.offset[2]), held: m.held, row: document.querySelector('#scene-list .obj[data-name="test_pallet.3mf"] .st')?.textContent }; });
  assert(carried.dz === 15 && carried.held && carried.row === "held", JSON.stringify(carried));
  await shot(page, "19_magnet_carrying_model.png");
  await page.keyboard.press("g");
  let pal = await page.evaluate(() => { const m = app.models.find((x) => x.name === "test_pallet.3mf"); return { z: m.offset[2], held: m.held, toast: app.lastToast }; });
  assert(Math.abs(pal.z) < 1e-3 && !pal.held && /Dropped test_pallet/.test(pal.toast), JSON.stringify(pal));
  // the STL cylinder (40 x 60): grab its top centre, release it over Cube 4 -> rests on the cube
  const part = await posOf("my_part.stl");
  await go(`${part[0]}, ${part[1]}, 61`);
  await page.keyboard.press("g");
  held = await page.evaluate(() => app.c.held?.body?.name);
  assert(held === "my_part.stl", "held " + held);
  await go("150, 150, 110");
  await page.keyboard.press("g");
  let cyl = await page.evaluate(() => { const m = app.models.find((x) => x.name === "my_part.stl"); return { off: m.offset.map(Math.round), toast: app.lastToast }; });
  assert(cyl.off[2] === 25 && Math.abs(cyl.off[0] - 150) < 2 && Math.abs(cyl.off[1] - 150) < 2, "settled on Cube 4: " + JSON.stringify(cyl));
  // Magnetic off: the magnet ignores it
  await page.locator('#scene-list .obj[data-name="my_part.stl"] .mag').click();
  await go("150, 150, 86");
  await page.keyboard.press("g");
  const ign = await page.evaluate(() => ({ held: app.c.held, mag: app.models.find((x) => x.name === "my_part.stl").magnetic, on: app.c.magnetOn }));
  assert(ign.held === null && ign.mag === false && ign.on, JSON.stringify(ign));
  await page.keyboard.press("g");
  await page.locator('#scene-list .obj[data-name="my_part.stl"] .mag').click();
  // ... and from a program: pick it up from the cube and put it down on the Tile
  const rc = await page.evaluate(() => app.host.runCount || 0);
  await page.evaluate(() => app.editor.open("from cte import *\narm = Arm()\narm.move_to(150, 150, 86)\narm.set_end_effector_magnet(True)\narm.move_to(150, 150, 120)\narm.move_to(60, 40, 120)\narm.set_end_effector_magnet(False)\narm.move_to(120, 0, 100)\n", { name: "carry.py" }));
  await page.locator("#btn-run").click();
  await page.waitForFunction((n) => app.host.runCount > n && app.host.state === "finished" && app.c.isDone(), rc, { timeout: 60000 });
  cyl = await page.evaluate(() => { const m = app.models.find((x) => x.name === "my_part.stl"); return { off: m.offset.map(Math.round), held: m.held }; });
  assert(!cyl.held && cyl.off[2] === 0 && Math.abs(cyl.off[0] - 60) < 2 && Math.abs(cyl.off[1] - 40) < 2, "program carry: " + JSON.stringify(cyl));
  return `pallet carried 15 mm under the tip and dropped; cylinder onto Cube 4 (z 25); program moved it to (${cyl.off})`;
});

await check("yaw and Magnetic are kept in scene files and the browser library", async () => {
  await page.evaluate(() => { const m = app.models.find((x) => x.name === "bambu_plate.3mf"); app.selectedObject = m; app.syncPanel(true); });
  await page.locator("#sel-magnetic").click();
  const json = await page.evaluate(() => app.sceneJSON());
  const d = JSON.parse(json);
  const bp = d.models.find((m) => m.name === "bambu_plate.3mf"), mp = d.models.find((m) => m.name === "my_part.stl");
  assert(bp.rot.join(",") === "0,0,15" && bp.magnetic === false && mp.magnetic === true && d.toggles.snap_to_surface === true && d.toggles.block_overlaps === true, JSON.stringify({ bp, mp, t: d.toggles }));
  await page.waitForFunction(async () => { await app.library.refresh(); return app.library.stored.find((s) => s.key === "bambu_plate.3mf")?.magnetic === false; }, null, { timeout: 5000, polling: 100 });
  const lib = await page.evaluate(() => app.library.stored.find((s) => s.key === "bambu_plate.3mf")?.magnetic);
  await page.evaluate(() => app.clearObjects());
  await pick("#file-scene", "my_scene.json", json, "application/json");
  await page.waitForFunction((n) => app.c.objects.length + app.models.length === n, d.objects.length + d.models.length, { timeout: 15000 });
  const back = await page.evaluate(() => { const m = app.models.find((x) => x.name === "bambu_plate.3mf"); return { yaw: m.rot[2], mag: m.magnetic, snap: app.snapToSurface }; });
  assert(back.yaw === 15 && back.mag === false && back.snap, JSON.stringify(back));
  // library default: re-adding bambu_plate gives a non-magnetic model; restore it afterwards
  const again = await page.evaluate(async () => { const m = await app.library.load({ stored: "bambu_plate.3mf" }, "bambu_plate.3mf"); return m.magnetic; });
  assert(again === false, "re-added model should default to non-magnetic");
  await page.evaluate(async () => { const m = app.models.find((x) => x.name === "bambu_plate.3mf"); app.setMagnetic(m, true); await app.library.setStoredMagnetic("bambu_plate.3mf", true); });
  // tidy up for the checks that follow: only the two imports and Cube 1 / Cube 2 stay
  await page.evaluate(() => { for (const b of [...app.c.objects, ...app.models]) if (/Cube [34]|test_pallet/.test(b.name)) app.removeObject(b); app.selectedObject = null; app.syncPanel(true); });
  return `scene: rot ${bp.rot}, magnetic ${bp.magnetic}; library default ${lib}; reloaded ${JSON.stringify(back)}`;
});

await check("rotate mode (R): rings turn a cube / disk / model about X, Y, Z with snapping; fields, steppers, Lay flat, Reset", async () => {
  await page.evaluate(() => { app.clearObjects(); app.resetObjects(); });        // Red cube (150,50), Blue cube (150,150), Green disk (50,200)
  await page.locator("#c3d").click({ position: { x: 40, y: 400 } });
  await selectBody("Green disk");
  await page.keyboard.press("r");
  await page.waitForFunction(() => app.gizmoMode === "rotate" && app.renderer.rings.visible, null, { timeout: 5000 });
  const modeUI = await page.evaluate(() => document.querySelector("#mode-seg .on")?.dataset.arg);
  assert(modeUI === "rotate", "mode segment " + modeUI);
  // drag the X ring from its 45 deg point to its 135 deg point -> +90 deg about X (snapped to 15): the disk stands on its rim
  const box = await canvasBox();
  const ringPts = await page.evaluate(() => {
    const [lo, hi] = app.objectBounds(app.selectedObject), c = lo.map((v, k) => (v + hi[k]) / 2), R = app.renderer._gizmo.radius;
    const at = (deg) => { const a = deg * Math.PI / 180; return [c[0], c[1] + R * Math.cos(a), c[2] + R * Math.sin(a)]; };
    return { a: app.renderer.project(at(45)), b: app.renderer.project(at(135)) };
  });
  await page.mouse.move(box.x + ringPts.a[0], box.y + ringPts.a[1]);
  await page.waitForTimeout(80);
  const hover = await page.evaluate(() => app.hoverAxis);
  await page.mouse.down();
  await page.mouse.move(box.x + ringPts.b[0], box.y + ringPts.b[1], { steps: 12 });
  await page.mouse.up();
  let d = await page.evaluate(() => { const o = app.c.objects.find((x) => x.name === "Green disk"); const [lo, hi] = app.objectBounds(o); return { rot: o.rot.map(Math.round), lo: lo.map((v) => +v.toFixed(2)), size: hi.map((v, k) => +(v - lo[k]).toFixed(1)), toast: app.lastToast }; });
  assert(hover === "x" && d.rot.join(",") === "90,0,0", `X ring drag: hover ${hover}, rot ${d.rot}, ${d.toast}`);
  assert(d.lo[2] === 0 && d.size.join(",") === "30,8,30", `disk on its rim, lifted onto the Tile: ${JSON.stringify(d)}`);
  await shot(page, "20_rotate_rings.png");
  // steppers and fields: 15 deg steps about Z, typed value about Y, snap step 45
  await page.locator('#sel-panel [data-action="rotate_axis"][data-arg="z,1"]').click();
  await page.locator('#sel-panel [data-action="rotate_axis"][data-arg="z,1"]').click();
  d = await page.evaluate(() => app.c.objects.find((x) => x.name === "Green disk").rot.map(Math.round));
  assert(d.join(",") === "90,0,30", "two Z steps: " + d);
  await page.locator('#rot-step-seg [data-arg="45"]').click();
  await page.locator('#sel-panel [data-action="rotate_axis"][data-arg="y,-1"]').click();
  d = await page.evaluate(() => app.c.objects.find((x) => x.name === "Green disk").rot.map(Math.round));
  assert(d.join(",") === "90,-45,30", "Y step of 45: " + d);
  await page.locator("#sel-rz").fill("120"); await page.keyboard.press("Enter");
  d = await page.evaluate(() => app.c.objects.find((x) => x.name === "Green disk").rot.map(Math.round));
  assert(d.join(",") === "90,-45,120", "typed Z 120: " + d);
  const bottom = await page.evaluate(() => Math.round(app.objectBounds(app.c.objects.find((x) => x.name === "Green disk"))[0][2] * 1000) / 1000);
  assert(bottom === 0, "still not below the Tile: " + bottom);
  await page.locator("#btn-lay-flat").click();
  d = await page.evaluate(() => app.c.objects.find((x) => x.name === "Green disk").rot.map(Math.round));
  assert(d.join(",") === "0,0,120", "Lay flat keeps the turn about Z: " + d);
  await page.keyboard.press("Control+z");
  d = await page.evaluate(() => app.c.objects.find((x) => x.name === "Green disk").rot.map(Math.round));
  assert(d.join(",") === "90,-45,120", "undo Lay flat: " + d);
  await page.locator("#btn-reset-rot").click();
  d = await page.evaluate(() => app.c.objects.find((x) => x.name === "Green disk").rot.map(Math.round));
  assert(d.join(",") === "0,0,0", "Reset: " + d);
  await page.locator('#rot-step-seg [data-arg="15"]').click();
  // a cube tilted 45 about X stands on an edge; snap to surface puts it onto the other cube by that edge
  await selectBody("Red cube");
  await page.locator("#sel-rx").fill("45"); await page.keyboard.press("Enter");
  await page.locator("#sel-y").fill("150"); await page.keyboard.press("Enter");
  const cube = await page.evaluate(() => { const o = app.c.objects.find((x) => x.name === "Red cube"); const [lo, hi] = app.objectBounds(o); return { rot: o.rot.map(Math.round), bottom: +lo[2].toFixed(3), h: +(hi[2] - lo[2]).toFixed(2) }; });
  assert(cube.rot.join(",") === "45,0,0" && cube.bottom === 25 && Math.abs(cube.h - 35.36) < 0.05, "tilted cube rests edge-down on the Blue cube: " + JSON.stringify(cube));
  // a model: the bundled pallet rolled onto its side with the Y ring is 60 mm tall and 14 wide
  await page.evaluate(async () => { await app.addModel({ library: "models/test_pallet.3mf" }, "test_pallet.3mf", { pos: [60, 100] }); });
  await selectBody("test_pallet.3mf");
  await page.locator("#sel-rx").fill("90"); await page.keyboard.press("Enter");
  const pal = await page.evaluate(() => { const m = app.models.find((x) => x.name === "test_pallet.3mf"); const [lo, hi] = m.worldBounds(); return { rot: m.rot.map(Math.round), size: hi.map((v, k) => Math.round(v - lo[k])), bottom: +lo[2].toFixed(3) }; });
  assert(pal.rot.join(",") === "90,0,0" && pal.size.join(",") === "90,14,60" && pal.bottom === 0, JSON.stringify(pal));
  // the magnet grabs the side-lying pallet by its top edge, carries it, and it lands upright-as-carried (still on its side)
  const c = await page.evaluate(() => { const m = app.models.find((x) => x.name === "test_pallet.3mf"); const [lo, hi] = m.worldBounds(); return [(lo[0] + hi[0]) / 2, hi[1] - 3, hi[2] + 1]; });
  await go(`${c.map((v) => v.toFixed(1)).join(", ")}`);
  await page.keyboard.press("g");
  const held = await page.evaluate(() => app.c.held?.body?.name);
  assert(held === "test_pallet.3mf", "held " + held);
  await go("200, 100, 120");
  await page.keyboard.press("g");
  const after = await page.evaluate(() => { const m = app.models.find((x) => x.name === "test_pallet.3mf"); const [lo, hi] = m.worldBounds(); return { rot: m.rot.map((v) => Math.round(v)), size: hi.map((v, k) => Math.round(v - lo[k])), bottom: +lo[2].toFixed(2), held: m.held }; });
  assert(!after.held && after.bottom === 0 && after.size[2] === 60 && after.rot[0] === 90 && after.rot[1] === 0, "put down on its side again (turned with the tool about Z): " + JSON.stringify(after));
  // all of it survives a scene round trip
  const json = await page.evaluate(() => app.sceneJSON());
  const sd = JSON.parse(json);
  assert(sd.objects.find((o) => o.name === "Red cube").rot.join(",") === "45,0,0" && Math.round(sd.models.find((m) => m.name === "test_pallet.3mf").rot[0]) === 90, "rot in the scene file");
  await page.evaluate(() => app.clearObjects());
  await pick("#file-scene", "rot_scene.json", json, "application/json");
  await page.waitForFunction((n) => app.c.objects.length + app.models.length === n, sd.objects.length + sd.models.length, { timeout: 15000 });
  const back = await page.evaluate(() => ({ cube: app.c.objects.find((x) => x.name === "Red cube").rot.map(Math.round), pal: app.models.find((x) => x.name === "test_pallet.3mf").rot.map(Math.round) }));
  assert(back.cube.join(",") === "45,0,0" && back.pal[0] === 90, "rot after reload: " + JSON.stringify(back));
  await page.keyboard.press("r");
  await page.evaluate(() => { app.removeObject(app.models.find((x) => x.name === "test_pallet.3mf")); app.clearObjects(); app.resetObjects(); app.selectedObject = null; app.syncPanel(true); });
  return `disk ${d} after Reset; tilted cube edge-down at 25; pallet on its side ${pal.size.join("×")}; carried on its side and reloaded`;
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
  await p.evaluate(() => app.openExample("01 Hello Arm.ctepython"));
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
