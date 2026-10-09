// The .ctepython export must be byte-identical to the VEXcode files (round trip).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as cte from "../js/ctefile.js";

const dir = new URL("../examples/", import.meta.url);
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ctepython"));

test("there are 8 class examples", () => assert.equal(files.length, 8));

for (const f of files) {
  test(`round trip ${f}`, () => {
    const bytes = fs.readFileSync(new URL(encodeURIComponent(f), dir));
    const text = cte.decodeBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), f);
    const p = cte.parseProjectText(text, f);
    assert.equal(p.fmt, "json");
    const out = cte.ctepythonText(p.source, p.raw);
    assert.equal(Buffer.from(out, "utf8").equals(bytes), true);
  });
}

test("plain Python text becomes a project", () => {
  const p = cte.parseProjectText("from cte import *\narm.move_to(120, 0, 100)\n", "x.py");
  assert.match(p.source, /move_to/);
  const obj = JSON.parse(cte.ctepythonText(p.source, null));
  assert.equal(obj.textContent, p.source);
});
