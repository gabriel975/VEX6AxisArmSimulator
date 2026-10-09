/* py_worker.js - Web Worker that runs the student's Python with Pyodide.
 *
 * Runs off the main thread, so a busy program never freezes the page.
 * Messages in:  {type:"init", pyodideUrl, pythonBase, version}
 *               {type:"run", source, name, startPaused}
 *               {type:"reply", id, result}            (answer to an arm call)
 *               {type:"pause"|"resume"|"step"|"speed"|"stop"|"tower_press"|"control_stopped", ...}
 * Messages out: {type:"loading", message} {type:"ready", version}
 *               {type:"load_error", message}
 *               {type:"call", id, name, args}          (Python wants the arm)
 *               plus whatever simrt.py posts (started, line, paused, screen, note,
 *               tower, error, done ...).
 */
/* global importScripts, loadPyodide */
"use strict";

let pyodide = null;
let simrt = null;
let nextId = 1;
const pending = new Map();
const early = [];          // control messages that arrive while Python loads

self.simPost = (text) => { self.postMessage(JSON.parse(text)); };
self.simCall = (name, args) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  self.postMessage({ type: "call", id, name, args: JSON.parse(args) });
});
self.simClock = () => performance.now() / 1000;

async function init(m) {
  try {
    self.postMessage({ type: "loading", message: "Downloading Python (Pyodide)…" });
    try {
      importScripts(m.pyodideUrl + "pyodide.js");
    } catch (e) {
      throw new Error(`could not download ${m.pyodideUrl}pyodide.js (${e && e.message ? e.message : e})`);
    }
    pyodide = await loadPyodide({ indexURL: m.pyodideUrl, stdout: (s) => console.log(s), stderr: (s) => console.warn(s) });
    self.postMessage({ type: "loading", message: "Starting Python…" });
    pyodide.FS.mkdirTree("/sim");
    for (const f of ["simrt.py", "vex.py", "cte.py"]) {
      const r = await fetch(m.pythonBase + f + (m.version ? "?v=" + m.version : ""));
      if (!r.ok) throw new Error(`could not load python/${f} (HTTP ${r.status})`);
      pyodide.FS.writeFile("/sim/" + f, await r.text());
    }
    pyodide.runPython(`
import sys
sys.path.insert(0, "/sim")
import js, simrt, vex, cte
simrt.BRIDGE.post = js.simPost
simrt.BRIDGE.call = js.simCall
simrt.BRIDGE.clock = js.simClock
`);
    simrt = pyodide.pyimport("simrt");
    self.postMessage({ type: "ready", version: pyodide.version });
    for (const e of early.splice(0)) handle(e);
  } catch (e) {
    self.postMessage({ type: "load_error", message: String(e && e.message ? e.message : e) });
  }
}

function handle(m) {
  if (m.type === "init") { init(m); return; }
  if (!simrt) { if (m.type !== "run") early.push(m); return; }
  if (m.type === "run") {
    simrt.start(m.source, m.name || "project", !!m.startPaused);
  } else if (m.type === "reply") {
    const resolve = pending.get(m.id);
    if (resolve) { pending.delete(m.id); resolve(JSON.stringify(m.result === undefined ? null : m.result)); }
  } else {
    simrt.on_message(JSON.stringify(m));
  }
}

self.onmessage = (ev) => handle(ev.data);
