// ctefile.js - VEXcode project files: load .ctepython / .exppython / .v5python /
// .py, and save / export in the exact VEXcode CTE format (port of v4 editor.py
// and project_runner.py). A VEXcode text project is a one-line JSON object whose
// "textContent" field holds the Python source.

export const CTE_HEADER = "#region VEXcode Generated Robot Configuration\nfrom cte import *\nimport math\nimport random\n\n# Brain should be defined by default\nbrain = Brain()\n\n# Robot configuration code\narm = Arm()\nsignal_tower = arm.signal_tower\n\n\n# Wait for sensor(s) to fully initialize\nwait(100, MSEC)\n\n#endregion VEXcode Generated Robot Configuration\n# ------------------------------------------\n# \n# \tProject:      VEXcode Project\n#\tAuthor:       VEX\n#\tCreated:\n#\tDescription:  VEXcode CTE Python Project\n# \n# ------------------------------------------\n\n# Library imports\nfrom cte import *\n\n# Begin project code\n";
export const NEW_PROJECT_BODY = "arm.move_to(120, 0, 100)\narm.move_to(200, 0, 50)\narm.move_to(120, 0, 100)\n";
export const NEW_PROJECT = CTE_HEADER + NEW_PROJECT_BODY;

// Field order and values of a real VEXcode CTE 4.67.0 Python project file.
export const CTE_FIELDS = [["mode", "Text"], ["hardwareTarget", "arm"], ["textContent", ""], ["textLanguage", "python"], ["robotConfig", []], ["slot", 0], ["platform", "arm"], ["sdkVersion", "20240802.15.00.00"], ["appVersion", "4.67.0"], ["minVersion", "4.0.0"], ["fileFormat", "2.0.0"], ["targetBrainGen", "First"], ["v5SoundsEnabled", false], ["aiVisionSettings", {"colors": [], "codes": [], "tags": true, "AIObjects": true, "AIObjectModel": [], "aiModelDropDownValue": null}]];

const CODE_KEYS = ["textContent", "text_content", "code", "source", "python", "program"];
export const PROJECT_EXTS = [".ctepython", ".exppython", ".v5python", ".iqpython", ".py", ".txt"];

export class ProjectFormatError extends Error {}

/** bytes (ArrayBuffer / Uint8Array) -> text, like v4 _decode (BOM, UTF-16). */
export function decodeBytes(buf, name = "file") {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const bom16 = (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff);
  if (bom16) return new TextDecoder(b[0] === 0xff ? "utf-16le" : "utf-16be").decode(b);
  if (b.subarray(0, 4096).includes(0)) throw new ProjectFormatError(`${name} looks like a binary file, not a VEXcode Python project`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);   // strips a UTF-8 BOM
  } catch {
    return new TextDecoder("latin1").decode(b);
  }
}

function fromJson(obj, name) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new ProjectFormatError("JSON file doesn't contain a VEXcode project object");
  const lang = String(obj.textLanguage ?? "python").toLowerCase();
  const key = CODE_KEYS.find((k) => typeof obj[k] === "string");
  const mode = String(obj.mode ?? "").toLowerCase();
  if (!key) {
    if (mode === "blocks" || "workspace" in obj || "blocks" in obj) {
      throw new ProjectFormatError("This is a VEXcode BLOCKS project. In VEXcode open the Code Viewer and choose " +
        "'Convert to Text Project' (Python), save it, then load that file.");
    }
    throw new ProjectFormatError(`JSON file has no 'textContent' field with Python code (found keys: ${Object.keys(obj).slice(0, 10).join(", ")})`);
  }
  if (!["python", "py", ""].includes(lang)) {
    throw new ProjectFormatError(`This project is written in ${obj.textLanguage}, only Python projects can run in the simulator`);
  }
  return { source: obj[key].replace(/\r\n/g, "\n"), name, fmt: "json", raw: obj };
}

/** Text of a project file -> {source, name, fmt: "json"|"text", raw}. */
export function parseProjectText(text, name = "project") {
  const lower = name.toLowerCase();
  if (/blocks$/.test(lower)) {
    throw new ProjectFormatError(`${name} is a Blocks project. Convert it to a Python text project in VEXcode first ` +
      "(Code Viewer > Convert to Text Project).");
  }
  if (/\.(cpp|v5cpp|expcpp|iqcpp|ctecpp)$/.test(lower)) throw new ProjectFormatError("C++ projects can't run in the simulator - use Python");
  const stripped = text.trimStart();
  if (stripped.startsWith("{")) {
    let obj;
    try { obj = JSON.parse(stripped); } catch (e) {
      throw new ProjectFormatError(`File starts like JSON but isn't valid JSON (${e.message})`);
    }
    return fromJson(obj, name);
  }
  if (!stripped) throw new ProjectFormatError("The project file is empty");
  return { source: text.replace(/\r\n/g, "\n"), name, fmt: "text", raw: null };
}

/** The VEXcode CTE project object: fields of a loaded file (raw) are kept as
 * they were; anything missing gets the VEXcode 4.67 default. */
export function ctepythonObject(source, raw = null) {
  raw = raw || {};
  const out = {};
  for (const [k, def] of CTE_FIELDS) out[k] = JSON.parse(JSON.stringify(k in raw ? raw[k] : def));
  for (const [k, v] of Object.entries(raw)) if (!(k in out)) out[k] = v;
  out.textContent = source;
  return out;
}

/** Serialise exactly like VEXcode: one line, no spaces, UTF-8 (no \\u escapes). */
export function ctepythonText(source, raw = null) {
  return JSON.stringify(ctepythonObject(source, raw));
}
