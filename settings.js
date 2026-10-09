// settings.js - the few things you might want to change when hosting the site.
//
// PYODIDE_URL: where the Python-in-the-browser runtime (Pyodide) is loaded from.
//   Default: the free jsDelivr CDN (about 12 MB, downloaded the first time someone
//   presses Run, then cached by the browser).
//
//   To self-host instead (e.g. a school network blocks cdn.jsdelivr.net):
//     1. Download https://github.com/pyodide/pyodide/releases/download/0.29.5/pyodide-core-0.29.5.tar.bz2
//        and unpack it (on Windows use 7-Zip: it is a .tar.bz2 inside, so extract twice).
//        You need these 5 files from it: pyodide.js, pyodide.asm.js, pyodide.asm.wasm,
//        python_stdlib.zip, pyodide-lock.json (about 12 MB total; the biggest is 8.7 MB).
//     2. Put them in a folder called "pyodide" next to index.html and upload it too.
//        (pyodide.asm.wasm is under 25 MB, so GitHub's web upload accepts it.)
//     3. Change the line below to:   export const PYODIDE_URL = "./pyodide/";
//   The URL must end with a slash. A relative path is resolved against index.html.
export const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/";

// How long Stop waits for a program to end by itself before the Python
// worker is shut down and restarted (milliseconds).
export const HARD_STOP_MS = 2000;

// Autosave the scene (objects, platform, overlays) in the browser.
export const AUTOSAVE = true;
