# Virtual 6-Axis Arm (web version)

A virtual VEX CTE 6-axis robot arm that runs in any modern browser. Students can
load the VEXcode Python projects from class (`.ctepython`), run them on a 3D arm,
step through them line by line, edit the code, and export it back to VEXcode.

Nothing to install, nothing to build. It is a plain static website, so it can be
hosted free on **GitHub Pages** (or Netlify, Cloudflare Pages, or any web server).

---

## 1. Put it on GitHub Pages (about 5 minutes, all in the browser)

1. **Unzip** `six_axis_arm_web.zip` on your computer. You get a folder with
   `index.html`, `README.md` and folders like `js`, `css`, `examples` ...
2. Sign in at <https://github.com>, click **+** (top right) → **New repository**.
   - Name it, for example `six-axis-arm`.
   - Choose **Public** (GitHub Pages is free for public repositories).
   - Tick **Add a README file** (this makes an empty repo you can upload to). You
     can leave everything else as is. Click **Create repository**.
3. In the new repository click **Add file** → **Upload files**.
4. Open the unzipped folder, select **everything inside it** (Ctrl+A / Cmd+A) and
   drag it onto the upload page.
   - Upload the **contents** of the folder, not the folder itself: `index.html`
     must end up at the top level of the repository, not inside a sub-folder.
   - Sub-folders (`js`, `vendor/three/addons` ...) are kept when you drag them in.
     (Dragging works in Chrome, Edge and Firefox; the "choose your files" dialog
     cannot pick folders.)
   - The hidden file `.nojekyll` should come along too. If your computer hides it,
     that is OK - the site works without it.
   - When GitHub asks to replace `README.md`, that's fine.
5. Wait until all files are listed, then click **Commit changes**.
6. Go to **Settings** → **Pages** (left menu).
   - Under **Build and deployment**, Source: **Deploy from a branch**.
   - Branch: **main**, folder: **/ (root)**. Click **Save**.
7. Wait 1-2 minutes, then refresh the Settings → Pages page. It shows
   **"Your site is live at https://YOUR-NAME.github.io/six-axis-arm/"**.
   Open that link. (The first visit after a change can take a few minutes.)

To update the site later: **Add file → Upload files** again with the changed files
(same names), and commit. Pages redeploys by itself.

Limits checked: the site has fewer than 100 files (GitHub's web upload accepts
100 at a time) and every file is far below GitHub's 25 MB web-upload limit.

## 2. Try it on your own computer first (optional)

Browsers do not allow the app's modules and the Python worker to load from a
file, so **double-clicking `index.html` does not work** (you get a blank page).
Use a tiny local web server instead:

1. Install Python 3 if you don't have it (<https://www.python.org>).
2. Open a terminal / command prompt **in the unzipped folder** and run
   ```
   python -m http.server
   ```
   (on macOS / Linux it may be `python3 -m http.server`).
3. Open <http://localhost:8000> in your browser. Press Ctrl+C in the terminal to stop.

## 3. Other free hosts

- **Netlify Drop**: go to <https://app.netlify.com/drop> and drag the unzipped folder
  onto the page. You get a link right away (sign up to keep it).
- **Cloudflare Pages**: in the dashboard go to Workers & Pages → Create → Pages →
  **Upload assets** (menu names change now and then), then drag the folder (or the zip)
  in. No build settings are needed.
- Any web server or LMS that can serve static files works too. Use the folder as is.

## 4. School networks

The first time someone presses **Run**, the app downloads Python for the browser
(Pyodide, about 12 MB, then cached) from `cdn.jsdelivr.net`.

- If **`github.io` is blocked**, use Netlify or Cloudflare Pages (above), or ask IT
  to allow your site's address.
- If **`cdn.jsdelivr.net` is blocked**, the 3D arm, joints, scene and editor still
  work, but programs can't run; the app shows a "Python could not load" message.
  Either ask IT to allow `cdn.jsdelivr.net`, or host Python yourself:

### Self-hosting Python (no CDN at all)

1. Download
   <https://github.com/pyodide/pyodide/releases/download/0.29.5/pyodide-core-0.29.5.tar.bz2>
   (6 MB) and unpack it. On Windows use **7-Zip** (open the `.tar.bz2`, then the `.tar`
   inside it); macOS and Linux can double-click / `tar xjf` it.
2. It contains a folder `pyodide`. Make a folder called **`pyodide`** next to
   `index.html` in your site and copy **just these 5 files** into it:
   `pyodide.js`, `pyodide.asm.js`, `pyodide.asm.wasm`, `python_stdlib.zip`,
   `pyodide-lock.json` (about 12 MB; the biggest, the `.wasm`, is 8.7 MB).
3. Open `settings.js` and change the `PYODIDE_URL` line to
   ```js
   export const PYODIDE_URL = "./pyodide/";
   ```
4. Upload the `pyodide` folder and the changed `settings.js`. The site then loads
   nothing from outside your own site. (Tested: all of it runs with every
   outside address blocked.)

## 5. Using the simulator

- **Examples** (Program section): the 8 class projects. Picking one opens it in the
  editor and runs it.
- **Load…** / **L**: open a `.ctepython` or `.py` file from your computer (or drop a
  file onto the 3D view). **Code** / **E** shows the editor; **Run** / **F5** runs it.
- **Save** (Ctrl+S) downloads the code in the file's own format; **Export** downloads
  a VEXcode CTE `.ctepython` you can open in VEXcode. Opening a class file and exporting
  it again gives a byte-for-byte identical file.
- **Pause** (Space), **Step line** (F10), **Step move** (F11), **Stop** (Esc),
  **Sim speed** 0.5× … 10× (`[` `]`).
- **F1** shows every key. Joints: sliders or 1-6 + arrows. Tool: W S A D R F to jog,
  T to type a target, H home, G magnet, Tab magnet / pen.
- **Scene objects**: **Add model** lists the cube, the disk, the models in `models/` and
  the models you imported. **Import model…** (M) opens your own `.stl` (binary or ASCII)
  or `.3mf` file; it is kept in this browser's library. 3MF files from Bambu Studio,
  PrusaSlicer, Orca or Cura work too, including several objects with their build
  transforms. Sizes are in mm; a model saved in meters (tiny) or far bigger than the
  platform is scaled automatically and the message says so. **Place** (P) then click the
  platform, drag objects with the mouse, Delete removes, Ctrl+Z / Ctrl+Y undo and redo.
  **Save scene** / **Load scene** download and open a scene `.json` (imported models are
  embedded). The scene is also autosaved in the browser.
- **Drop files on the 3D view**: models (`.stl`, `.3mf`), scenes (`.json`) and programs
  (`.ctepython`, `.py`) all land in the right place. The file pickers are just as
  forgiving: picking an STL in *Load scene*, or a scene in *Import model…*, simply does the
  right thing and tells you.
- **Platform**: size presets or type a size. **Overlays**: reach map, path trail,
  collision stop settings. Section titles fold and unfold.

### Adding your own bundled models / examples

- Put `.stl` / `.3mf` files in `models/` and add a line for each in `models/index.json`.
- Put `.ctepython` files in `examples/` and list them in `examples/index.json`.

## 6. How it works (for the curious)

- **3D**: three.js (vendored in `vendor/three`). The arm kinematics, joint limits,
  IK, reach map and collision checks are JavaScript ports of the Python v4 simulator
  (`js/kinematics.js`, `js/arm_core.js` ...). All arm dimensions and limits are in
  `js/arm_config.js`, with notes saying which numbers are measured and which are estimates.
- **Python**: the student's program runs in real CPython compiled to WebAssembly
  (Pyodide) inside a **Web Worker**, so the page never freezes and Stop always works.
  `python/vex.py` and `python/cte.py` provide the VEXcode `cte` / `vex` API; arm commands
  send a message to the page, which moves the 3D arm and replies when the move is done.
- **Why no SharedArrayBuffer**: the usual way to let a worker "block" while waiting
  for the page needs SharedArrayBuffer, which needs the COOP/COEP HTTP headers.
  GitHub Pages can't send those headers. Rather than a service-worker hack, the app
  rewrites the program before running it (`python/simrt.py`): functions become `async`,
  calls are awaited, and a small hook runs before every line. That hook also gives the
  line highlight, Pause, Step and Stop. Threads (`cte_thread`, `Thread`, `Event`) are
  asyncio tasks. This works on any static host with no special headers.
- **Known limits of that approach** (none of the class projects hit them): a student
  function used as a callback by Python itself (e.g. `sorted(..., key=my_function)`)
  or arm commands inside `__init__` / `@property` / lambdas / generators don't work
  (the app explains this in the error message). Generator expressions such as
  `sum(f(x) for x in data)` work, but are evaluated all at once like a list.
  If a program swallows Stop with a bare `except:` in a loop, the Python worker is
  restarted after 2 seconds (`HARD_STOP_MS` in `settings.js`).
- `settings.js` holds the few settings (Python URL, stop timeout, autosave).

## 7. Tests (optional, for developers)

- `node --test tests/*.test.mjs` - kinematics, IK, reach map and collision results compared with
  fixtures generated by the Python simulator, the byte-identical `.ctepython` export
  round trip for the 8 examples, and the model file readers (binary / ASCII STL, 3MF with the
  production extension, file-type detection, auto scaling). Needs Node 20+.
- `python tests/test_simrt.py` - the Python program runner (`python/simrt.py`) in normal
  CPython: the 8 examples, Stop, errors with line numbers, threads, wait().
- `tests/e2e_browser.mjs` - Playwright browser test (UI, all 8 samples, export, models,
  scenes, layout). See the comment at the top of the file for how to run it.

## Credits and licenses

- three.js - MIT (`vendor/three/LICENSE.txt`)
- CodeMirror 6 - MIT (`vendor/codemirror-LICENSE.txt`)
- fflate (inside three.js addons) - MIT
- Pyodide - MPL 2.0, loaded from jsDelivr (not included)
- Inter and JetBrains Mono fonts - SIL Open Font License (`fonts/*-OFL.txt`)
