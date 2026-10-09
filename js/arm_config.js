// arm_config.js - Dimensions, joint limits and motion settings of the virtual
// 6-axis arm (millimetres and degrees). Each value is tagged
//   [REAL]      published by VEX (brochure, API docs, STEM Labs text)
//   [MEASURED]  read off VEX's own to-scale diagrams (25 mm grid overlays, see
//               [S7]); accuracy about +/- 2 mm unless noted
//   [DERIVED]   arithmetic on REAL / MEASURED numbers
//   [ESTIMATE]  our own guess - VEX doesn't publish it and it is not visible
//
// Sources:
//  [S1] VEX CTE brochures (official VEX sales sheets, hosted by distributors):
//       https://www.getsetlearn.info/wp-content/uploads/2026/05/digital-vex-cte-kit-brochure.pdf
//         "Arm maximum reach: 335 mm", "Platform size: 638 x 333 mm" (the Workcell = 2 Tiles)
//       https://www.tomega.lv/wp-content/uploads/2025/04/VEX-CTE-Worcell-brochure.pdf
//         "Arm maximum reach: 13 in", "Platform size: 25x13 in"
//  [S2] VEX STEM Labs, CTE Unit 3 (Coding Movements) lessons 3-5: "the 6-Axis Arm will
//       start by moving to the Safe Position (120, 0, 100)"; default jog step 10 mm
//       https://education.vex.com/stemlabs/cte/introduction-to-the-6-axis-arm/coding-movements/lesson-3-autonomous-movement-along-the-x-axis
//  [S3] https://api.vex.com/exp/home/python/Arm.html (API names, MAGNET default
//       tool, speed 1-100 % with default 50 %, pen offset reset to 0)
//  [S4] https://api.vex.com/exp/home/blocks/arm.html (pen offset "approximately 23 mm")
//  [S5] https://www.vexrobotics.com/cte-arm.html (2.5 kg, 6 rotational joints, kit
//       contents: 1 CTE Tile + 4 CTE Tile Frames, Signal Tower, 10 Disks, 9 Cubes, 2 Pallets).
//       The CAD download (https://www.vexrobotics.com/cadmodels/upload/download/upload_id/4be9ff07-bdf1-4e75-be94-1b50cdc29e2c,
//       short links https://link.vex.com/cad/cte-arm and https://link.vex.com/cad/cte) sits
//       behind a Cloudflare browser check that could not be passed from the build
//       environment, so no number here comes from the STEP files.
//  [S6] VEX STEM Labs, CTE Unit 1 Lesson 3 "The Coordinate System of the 6-Axis Arm":
//       "The (0, 0, 0) on the 6-Axis Arm is located at the center of the base",
//       "each of the individual squares on the Tile is 50mm by 50mm", TCP at Tile
//       location 36 is (200, 200, 0).
//       https://education.vex.com/stemlabs/cte/introduction-to-the-6-axis-arm/introduction-to-robotic-arms/lesson-3-the-coordinate-system-of-the-6-axis-arm
//  [S7] The to-scale diagrams in [S6] (VEX renders with a labelled 25 mm grid):
//       side view  https://education.vex.com/stemlabs/sites/default/files/inline-images/Screenshot%202024-02-01%20at%204.16.27%20PM.png
//       top view   https://education.vex.com/stemlabs/sites/default/files/inline-images/Screenshot%202024-02-01%20at%204.16.04%20PM.png
//       (200,200,0) https://education.vex.com/stemlabs/sites/default/files/inline-images/Screenshot%202024-02-01%20at%204.16.12%20PM.png
//       one square https://education.vex.com/stemlabs/sites/default/files/inline-images/Workcell%20Grid%20-%20Zoom.png
//       The Tile measures 333 mm across in both views (matching [S1]), which is how
//       the scale was checked. Pixel positions were measured by script (3.375 px/mm).
//  [S8] VEX STEM Labs, CTE Unit 3 axis call-outs and Unit 1 axes picture: the Tile is
//       square with 36 numbered 50 mm locations (1-6 along the back edge, 31-36 along
//       the front), the arm sits over locations 1-2 / 7-8 at the back-left, +X points
//       to the front edge and +Y to the right (toward the Signal Tower at location 6).
//       https://education.vex.com/stemlabs/sites/default/files/inline-images/CTE%20Unit%203%20Lesson%203-%20Axis%20Callout.png
//       https://education.vex.com/stemlabs/sites/default/files/inline-images/Screen%20Shot%202023-11-08%20at%201.09.12%20PM%20%282%29.png
//  [S9] VEX STEM Labs, CTE Workcell Automation Unit 4 Lesson 1 (two Tiles side by side
//       along the arm's +Y, Signal Tower at the far corner; "CTE Tile Frames lift the
//       Tiles off of the table top, allowing you to run cables underneath")
//       https://education.vex.com/stemlabs/cte/workcell-automation/material-transportation/lesson-1-understanding-conveyors
//       https://education.vex.com/stemlabs/sites/default/files/inline-images/CTE%20Callout-TransportConveyor.png
//
// Coordinate frame (same as VEXcode [S6][S8]): origin at the centre of the arm's
// base on the Tile surface, +X straight out in front of the arm, +Y to the arm's
// left, +Z up. The origin is the centre of Tile location 8, so the location
// centres are at X, Y = -50, 0, 50, 100, 150, 200 (location 36 = (200, 200)).

// ----------------------------------------------------------------- arm links ---
export const BASE_HEIGHT = 84.0;        // [MEASURED +/-1] Tile to the J2 shoulder axis [S7]
export const SHOULDER_OFFSET = 20.5;    // [MEASURED +/-1] the J2 axis sits this far in front (+X) of the J1 axis [S7]
export const UPPER_ARM = 133.0;         // [MEASURED +/-1.5] J2 axis to J3 elbow axis [S7]
export const FOREARM = 174.0;           // [MEASURED +/-2] J3 axis to J5 wrist axis, along the forearm [S7]
export const ELBOW_OFFSET = 28.0;       // [MEASURED +/-3] the forearm tube runs this far above the elbow axis [S7]
export const FOREARM_REACH = Math.hypot(FOREARM, ELBOW_OFFSET);   // [DERIVED] straight line J3 -> J5
export const WRIST_TO_FLANGE = 13.0;    // [MEASURED +/-3] J5 axis to the tool mounting face [S7]

export const TOOL_LENGTH = {
  MAGNET: 38.5,   // [MEASURED +/-3] Magnet Pickup Tool, mounting face to TCP; J5 axis -> TCP = 51.5 mm [S7]
  PEN: 45.0,      // [ESTIMATE] Pen Holder Tool body; VEX adds the pen offset [S3]
  NONE: 0.0,
};
export const DEFAULT_PEN_OFFSET = 0.0;  // [REAL] VEX resets the pen offset to 0 [S3]
export const TYPICAL_PEN_OFFSET = 23.0; // [REAL] "approximately 23 mm" for the kit marker [S4]

// Advertised maximum reach [REAL] [S1]. From the measured links the TCP can get
// 20.5 + 133 + 176 = 330 mm from the base axis with the tool pointing down, so
// VEX's 335 is read as the flange-ish reach rounded up. Shown in the readout only.
export const MAX_REACH = 335.0;

// ----------------------------------------------------------------- the Tile ---
// One CTE Tile with its 4 Tile Frames [S1][S5][S7]. 6 x 6 numbered 50 mm squares
// (300 mm) are centred on it; the rest is the frame + margin. The Workcell
// brochure's "638 x 333" is two Tiles side by side (2 x 305 + 2 x 14) [S1][S9].
export const TILE_SIZE = 333.0;                   // [REAL] [S1] (333 mm across in the diagrams [S7])
export const TILE_GRID = 50.0;                    // [REAL] [S6]
export const TILE_CELLS = 6;                      // [REAL] 36 locations [S8]
export const TILE_BORDER = (TILE_SIZE - TILE_CELLS * TILE_GRID) / 2;   // [DERIVED] 16.5 mm
export const TILE_THICKNESS = 28.0;               // [MEASURED +/-1] Tile + Frame height above the table [S7]
export const HOLE_PITCH = 25.0;                   // [MEASURED] 2 x 2 hole clusters at every 25 mm grid node [S7 zoom]
export const HOLE_SPLIT = 12.5;                   // [MEASURED] distance between the holes of a cluster [S7 zoom]
export const HOLE_DIAMETER = 4.2;                 // [ESTIMATE] clearance for the kit's #8-32 screws [S5]

export const PLATFORM_SIZE = [TILE_SIZE, TILE_SIZE];      // width along X, depth along Y
// The base centre is the centre of location 8: 1.5 squares + the border from the
// back (-X) edge and from the right-hand (-Y) edge [S6][S8]. The platform is
// drawn from these margins, so a resized platform grows to the front and left.
export const PLATFORM_BACK_MARGIN = TILE_BORDER + 1.5 * TILE_GRID;   // [DERIVED] 91.5 mm
export const PLATFORM_SIDE_MARGIN = TILE_BORDER + 1.5 * TILE_GRID;   // [DERIVED] 91.5 mm
export const PLATFORM_MIN = 200.0;
export const PLATFORM_MAX = 2000.0;
export const PLATFORM_PRESETS = [["CTE Tile", TILE_SIZE, TILE_SIZE], ["Workcell", TILE_SIZE, 638.0], ["Large", 1000.0, 600.0]];

// ------------------------------------------------------------------ the base ---
export const BASE_RADIUS = 69.0;        // [MEASURED +/-1] flange ring on the Tile, 138 mm across [S7]
export const BASE_FLANGE_HEIGHT = 13.0; // [MEASURED +/-1] the dark chamfered ring [S7]
export const BASE_BODY_RADIUS = 52.0;   // [MEASURED +/-1] cylinder above the flange, 104 mm across [S7]
export const BASE_BODY_HEIGHT = 47.0;   // [MEASURED +/-1] top of the fixed base [S7]
export const TURRET_RADIUS = 43.0;      // [MEASURED +/-1] the rotating part under the shoulder [S7]
export const BASE_BOLT_CIRCLE = 61.0;   // [MEASURED +/-2] 4 mounting bosses at 45 degrees [S7 top view]
// Visual link sizes [ESTIMATE from the pictures]
export const LINK_RADIUS = 16.0;
export const JOINT_RADIUS = 21.0;

// Joint limits in degrees. Zero pose = upper arm straight up, forearm and tool
// pointing forward (+X). ALL ranges are [ESTIMATE]s - VEX doesn't publish them.
export const JOINT_NAMES = ["J1 Base yaw", "J2 Shoulder", "J3 Elbow", "J4 Wrist roll", "J5 Wrist pitch", "J6 Tool roll"];
export const JOINT_LIMITS = [
  [-170.0, 170.0],   // J1 [ESTIMATE]
  [-90.0, 90.0],     // J2 [ESTIMATE]
  [-90.0, 70.0],     // J3 [ESTIMATE] (-90 = arm fully straight up)
  [-150.0, 150.0],   // J4 [ESTIMATE]
  [-120.0, 120.0],   // J5 [ESTIMATE]
  [-180.0, 180.0],   // J6 [ESTIMATE]
];

export const MAX_JOINT_SPEED = [90.0, 75.0, 90.0, 150.0, 150.0, 180.0];  // deg/s at 100 % [ESTIMATE]
export const MAX_LINEAR_SPEED = 200.0;                                  // mm/s at 100 % [ESTIMATE]
export const DEFAULT_SPEED_PERCENT = 50;                                // [REAL] [S3]

export const SAFE_POSITION = [120.0, 0.0, 100.0];   // [REAL] VEX "safe position" [S2]
export const FLOOR_Z = 0.0;
export const FLOOR_MARGIN = 2.0;
// Wrist / flange / tool may not enter these cylinders around the base axis
// [(radius, height), ...]: the flange + body, and the turret up to the shoulder.
export const BASE_KEEPOUT = [[BASE_RADIUS + 4, BASE_BODY_HEIGHT + 12], [TURRET_RADIUS + 6, BASE_HEIGHT + 20]];   // [DERIVED]
