// The .ctepython export must be byte-identical to VEXcode CTE files (round trip).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as cte from "../js/ctefile.js";

const dir = new URL("../examples/", import.meta.url);
const index = JSON.parse(fs.readFileSync(new URL("index.json", dir), "utf8"));
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ctepython")).sort();

// A VEXcode CTE 4.67 text project exactly as the app writes it: one line of JSON,
// no spaces, UTF-8, the 14 fields in VEXcode's order. Built here so the format
// check does not depend on which example files happen to be bundled.
const SAMPLE_SOURCE = cte.CTE_HEADER + "def main():\n    arm.move_to(150, 0, 30)   # square 26 — 30 mm up\n    brain.screen.print(\"héllo\")\n\n# CTE threads — Do not delete\ncte_thread(main)\n";
const sampleBytes = () => {
  const fields = {
    mode: "Text", hardwareTarget: "arm", textContent: SAMPLE_SOURCE, textLanguage: "python", robotConfig: [], slot: 0, platform: "arm",
    sdkVersion: "20240802.15.00.00", appVersion: "4.67.0", minVersion: "4.0.0", fileFormat: "2.0.0", targetBrainGen: "First", v5SoundsEnabled: false,
    aiVisionSettings: { colors: [], codes: [], tags: true, AIObjects: true, AIObjectModel: [], aiModelDropDownValue: null },
  };
  return Buffer.from(JSON.stringify(fields), "utf8");
};

test("synthetic VEXcode CTE project: parse, export byte-identical, field order and header", () => {
  const bytes = sampleBytes();
  const text = cte.decodeBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), "sample.ctepython");
  const p = cte.parseProjectText(text, "sample.ctepython");
  assert.equal(p.fmt, "json");
  assert.equal(p.source, SAMPLE_SOURCE);
  assert.ok(Buffer.from(cte.ctepythonText(p.source, p.raw), "utf8").equals(bytes), "export differs from the original bytes");
  assert.deepEqual(Object.keys(cte.ctepythonObject("x", null)), cte.CTE_FIELDS.map(([k]) => k), "field order");
  assert.ok(!cte.ctepythonText("é — ü").includes("\\u"), "non-ASCII is written as UTF-8, not \\u escapes");
  for (const line of ["from cte import *", "brain = Brain()", "arm = Arm()", "signal_tower = arm.signal_tower", "wait(100, MSEC)"]) assert.ok(cte.CTE_HEADER.includes(line), line);
});

test("the bundled examples are listed in index.json with a name and a description", () => {
  assert.ok(files.length >= 10, `${files.length} example files`);
  assert.deepEqual(index.examples.map((e) => e.file), files, "index.json lists exactly the files in examples/, in order");
  for (const e of index.examples) assert.ok(e.name && e.info, `${e.file} needs a name and an info line`);
});

for (const f of files) {
  test(`round trip ${f}`, () => {
    const bytes = fs.readFileSync(new URL(encodeURIComponent(f), dir));
    const text = cte.decodeBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), f);
    const p = cte.parseProjectText(text, f);
    assert.equal(p.fmt, "json");
    assert.deepEqual(Object.keys(p.raw), cte.CTE_FIELDS.map(([k]) => k), "VEXcode field order");
    assert.ok(p.source.startsWith(cte.CTE_HEADER.slice(0, cte.CTE_HEADER.indexOf("# Begin project code"))), "VEXcode CTE preamble");
    assert.match(p.source, /\n# CTE threads — Do not delete\ncte_thread\(main\)\n$/, "ends with the cte_thread(main) pattern");
    assert.ok(Buffer.from(cte.ctepythonText(p.source, p.raw), "utf8").equals(bytes), "export is not byte-identical");
  });
}

test("plain Python text becomes a project", () => {
  const p = cte.parseProjectText("from cte import *\narm.move_to(120, 0, 100)\n", "x.py");
  assert.match(p.source, /move_to/);
  const obj = JSON.parse(cte.ctepythonText(p.source, null));
  assert.equal(obj.textContent, p.source);
});
