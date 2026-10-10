# Virtual 6-Axis Arm (web version)

A virtual VEX CTE 6-axis robot arm that runs in any modern browser. Students can
load their VEXcode Python projects (`.ctepython`), run them on a 3D arm, step through
them line by line, edit the code, and export it back to VEXcode.

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

- **Examples** (Program section): ten short, commented example programs, from
  *Hello Arm* to *Speed Demo*. Picking one opens it in the editor and runs it on the
  default scene (press **N** first if you have moved the cubes):

  | Example | What it shows |
  | --- | --- |
  | 01 Hello Arm | print to the Brain screen, Safe Position, a few Tile squares, `get_x/y/z` |
  | 02 Move Relative | `move_inc` in X, Y and Z, with prints |
  | 03 Pen Square | the pen tool: a square and a triangle on the Tile |
  | 04 Pick and Place Basics | magnet pick, approach / retreat heights, release |
  | 05 Stack Cubes | the red cube onto the blue cube |
  | 06 Loops and Lists | visit a list of squares in a `for` loop |
  | 07 Functions | `go_above` / `pick` / `place` helpers, objects moved and put back |
  | 08 Signal Tower | lamp colours, blinking, and the tower button (B) via `pressed` |
  | 09 Reach Check | `can_arm_reach_to` before moving; skipped points are printed |
  | 10 Speed Demo | `set_speed` 20 / 100 / 50 % with timings from the Brain timer |
- **Load…** / **L**: open a `.ctepython` or `.py` file from your computer (or drop a
  file onto the 3D view). **Code** / **E** shows the editor; **Run** / **F5** runs it.
- **Save** (Ctrl+S) downloads the code in the file's own format; **Export** downloads
  a VEXcode CTE `.ctepython` you can open in VEXcode. Opening a VEXcode file and exporting
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
- **Moving an object precisely**: click an object and a **move gizmo** appears - drag the
  red (X), green (Y) or blue (Z) arrow to move along that axis only. The *Selected* panel
  under the list has **X / Y / Z fields** (type a value in mm) and **−/+ steppers** with a
  **Step** of 1, 5, 10 or 50 mm. Keyboard: **arrow keys** nudge in X / Y, **PageUp / PageDown**
  (or Shift+Up / Down) in Z - the arrows go back to jogging the joint when nothing is
  selected (Esc deselects). Objects can be raised and **stacked** on cubes, pallets or any
  model, and never go below the Tile. With **Snap to surface** on, a moved object rests on
  whatever is under it (drag a cube over a pallet and it climbs in); **Drop** lets a raised
  object fall. **Block overlaps** refuses moves that would put an object inside another
  (switch it off to just get a warning).
- **Rotating an object** (cubes, the disk and imported models alike): press **R** or pick
  **Rotate** in the panel and the gizmo becomes three rings - drag the red / green / blue
  ring to turn about X / Y / Z, snapped to the **Snap** step (1, 5, 15, 45 or 90°; hold
  Shift for free rotation). The panel also has **↻X / ↻Y / ↻Z** fields in degrees with
  −/+ steppers (`,` and `.` turn about Z), **Lay flat** (removes the tilt, keeps the turn
  about Z) and **Reset**. An object turns about its own centre; if a corner would end up
  under the Tile it is lifted, and with Snap on it settles on whatever is below - a disk
  stood on its rim, a cube tilted onto an edge or a pallet rolled onto its side all rest
  correctly, collide with the arm as their real shape, and the magnet grabs them by their
  actual top and keeps their orientation while carrying (the object tilts with the tool).
  Rotation is kept in scene files and in undo / redo.
- **Objects behave like their shape**: collisions between the arm and an STL / 3MF use the
  real triangles (a BVH), so the tool can reach into a pallet's slots without a false alarm
  and is stopped by its walls; rotated cubes and disks are checked the same way. Every imported model has a **Magnetic**
  checkbox (on by default, remembered in scene files and in the browser library): the
  magnet picks it up when the tool tip is within a few millimetres of its surface, carries
  it rigidly (it turns with the tool), and on release it settles on the Tile, a cube or
  another model under it. This works from the G key, the Magnet button and from programs
  (`arm.set_end_effector_magnet(True)`). Cubes and disks dropped by the magnet settle the
  same way.
- **Drop files on the 3D view**: models (`.stl`, `.3mf`), scenes (`.json`) and programs
  (`.ctepython`, `.py`) all land in the right place. The file pickers are just as
  forgiving: picking an STL in *Load scene*, or a scene in *Import model…*, simply does the
  right thing and tells you.
- **Platform**: the real **CTE Tile** (333 × 333 mm, 36 numbered 50 mm squares, the arm
  on location 8 at the back-left), the two-tile **Workcell** (333 × 638 mm, second Tile
  on the arm's left), **Large**, or type a size. **Overlays**: reach map, path trail,
  collision stop settings. Section titles fold and unfold.

### Adding your own bundled models / examples

- Put `.stl` / `.3mf` files in `models/` and add a line for each in `models/index.json`.
- Put `.ctepython` files in `examples/` and list them in `examples/index.json` (`file`,
  `name` and a one-line `info`). The bundled ones all end with the VEXcode
  `def main(): ... cte_thread(main)` pattern.

## 6. How it works (for the curious)

- **3D**: three.js (vendored in `vendor/three`). The arm kinematics, joint limits,
  IK, reach map and collision checks are JavaScript ports of the Python v4 simulator
  (`js/kinematics.js`, `js/arm_core.js` ...). All arm dimensions and limits are in
  `js/arm_config.js`, with notes saying which numbers are measured and which are estimates
  (summary below).
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
- **Known limits of that approach** (none of the bundled examples hit them): a student
  function used as a callback by Python itself (e.g. `sorted(..., key=my_function)`)
  or arm commands inside `__init__` / `@property` / lambdas / generators don't work
  (the app explains this in the error message). Generator expressions such as
  `sum(f(x) for x in data)` work, but are evaluated all at once like a list.
  If a program swallows Stop with a bare `except:` in a loop, the Python worker is
  restarted after 2 seconds (`HARD_STOP_MS` in `settings.js`).
- `settings.js` holds the few settings (Python URL, stop timeout, autosave).

### Real vs estimated dimensions

VEX publishes the arm's CAD, but the download sits behind a browser check that blocks
automated access, so the STEP files could not be measured. Instead the geometry comes
from VEX's own **to-scale diagrams** in the CTE STEM Labs (Unit 1 Lesson 3, *The
Coordinate System of the 6-Axis Arm*, which overlays a labelled 25 mm grid on a side
view and a top view of the arm on its Tile) plus the brochure and API numbers. The Tile
measures exactly 333 mm in those diagrams, which is how the scale was verified; pixel
positions were measured by script, so the values are good to about ±2 mm. Every value
is tagged in `js/arm_config.js` with its source.

| What | Value | Status | Was (before Oct 2026) |
| --- | --- | --- | --- |
| Tile (with its 4 Frames) | 333 × 333 mm, 28 mm tall, top = z 0 | real / measured | 638 × 333 flat (that is the two-tile Workcell) |
| Squares / holes | 6 × 6 numbered 50 mm squares; 2 × 2 hole clusters 12.5 mm apart at every square corner and centre | real / measured | 50 mm grid lines only |
| Base position | origin = centre of location 8: 91.5 mm from the back and right-hand edges | real (lesson) | centred on the back edge, 219 mm in |
| Axes | +X to the front edge (locations 31-36), +Y to the left (towards location 6, the Signal Tower) | real (lesson) | same |
| Base | Ø138 flange 13 mm tall with 4 bosses, Ø104 body to 47 mm, Ø86 turret | measured | Ø110 cylinder |
| Shoulder (J2) axis | 84 mm up, **20.5 mm in front of the base axis** | measured | 95 mm up, no offset |
| Upper arm (J2 → J3) | 133 mm | measured | 167.5 (estimate) |
| Forearm (J3 → J5) | 174 mm forward, forearm tube **28 mm above the elbow axis** | measured | 167.5, in line |
| Wrist (J5) → flange | 13 mm | measured | 25 (estimate) |
| Magnet tool | 38.5 mm (J5 axis to TCP = 51.5 mm) | measured | 25 (estimate) |
| Pen tool body | 45 mm + the pen offset (VEX: ≈ 23 mm) | estimate | same |
| Max reach | 335 mm advertised; the measured links give about 328 mm tool-down | real | same |
| Safe position | (120, 0, 100) | real | same |
| Joint limits, speeds | see `arm_config.js` | estimates | same |

Consequences for programs: the bundled examples all run to the end; the furthest they
reach (200, 150) at the Tile is 250 mm from the base, well inside the envelope. The overall reach barely changed (tool pointing down: about 328 mm instead of 335;
stretched out: about 375 instead of 385), what changed is the shape - a lower shoulder, a
shorter upper arm and a longer, offset forearm - so joint angles for a given point and
the collision silhouette now follow the real arm. Location 36 (200, 200, 0) is reachable
tool-down, as in VEX's lesson picture, and the whole Tile is green on the reach map.

## 7. Tests (optional, for developers)

- `node --test tests/*.test.mjs` - the mesh BVH, stacking / snap / overlap rules, rotation of every
  object type, mesh-based arm collisions and the magnet carrying (possibly tilted) objects
  (`tests/bodies.test.mjs`); kinematics, IK, reach map and collision results compared with
  `tests/kinematics_fixtures.json` (a regression snapshot made by `node tests/gen_fixtures.mjs`;
  regenerate it when `js/arm_config.js` changes), the byte-identical `.ctepython` export
  round trip for every bundled example plus a synthetic VEXcode file, and the model file readers (binary / ASCII STL, 3MF with the
  production extension, file-type detection, auto scaling). Needs Node 20+.
- `python tests/check_fk_fixtures.py` - recomputes the forward kinematics of every fixture
  pose in plain Python (no shared code with the JavaScript) and checks VEX's lesson pose.
- `python tests/test_simrt.py` - the Python program runner (`python/simrt.py`) in normal
  CPython: the bundled examples, Stop, errors with line numbers, threads, wait().
- `tests/e2e_browser.mjs` - Playwright browser test (UI, every bundled example, export, models,
  scenes, the move / rotate gizmo, position and rotation editor, keyboard nudges, stacking,
  overlaps, mesh collisions, the magnet with models, undo / redo, layout). See the comment at the top of
  the file for how to run it.

## Credits and licenses

- three.js - MIT (`vendor/three/LICENSE.txt`)
- CodeMirror 6 - MIT (`vendor/codemirror-LICENSE.txt`)
- fflate (inside three.js addons) - MIT
- Pyodide - MPL 2.0, loaded from jsDelivr (not included)
- Inter and JetBrains Mono fonts - SIL Open Font License (`fonts/*-OFL.txt`)
