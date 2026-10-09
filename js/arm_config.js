// arm_config.js - Dimensions, joint limits and motion settings of the virtual
// 6-axis arm (millimetres and degrees). Same numbers as the Python version
// (six_axis_arm/arm_config.py). Each value is tagged [REAL] (published by VEX)
// or [ESTIMATE] (our own guess - VEX doesn't publish it).
//
// Sources:
//  [S1] VEX CTE brochures (official VEX sales sheets, hosted by distributors):
//       https://www.getsetlearn.info/wp-content/uploads/2026/05/digital-vex-cte-kit-brochure.pdf
//         "Arm maximum reach: 335 mm", "Platform size: 638 x 333 mm"
//       https://www.tomega.lv/wp-content/uploads/2025/04/VEX-CTE-Worcell-brochure.pdf
//         "Arm maximum reach: 13 in", "Platform size: 25x13 in"
//  [S2] VEX STEM Labs, CTE 6-Axis Arm, lesson 4 ("safe position, at approximately
//       (120, 0, 100)"; default jog step 10 mm)
//  [S3] https://api.vex.com/exp/home/python/Arm.html (API names, MAGNET default
//       tool, speed 1-100 % with default 50 %, pen offset reset to 0)
//  [S4] https://api.vex.com/exp/home/blocks/arm.html (pen offset "approximately 23 mm")
//  [S5] https://www.vexrobotics.com/cte-arm.html (2.5 kg, 6 rotational joints;
//       the CAD download could not be fetched, so link lengths are NOT from CAD)
//  [S6] VEX STEM Labs, CTE lesson 3 (origin at the centre of the base on the
//       Tile, z measured from the Tile, 50 mm grid squares)
//
// Coordinate frame (same as VEXcode [S6]): origin at the centre of the arm's base
// on the Tile surface, +X straight out in front, +Y to the arm's left, +Z up.

export const BASE_HEIGHT = 95.0;        // [ESTIMATE] table to shoulder axis
export const UPPER_ARM = 167.5;         // [ESTIMATE split of a REAL total] shoulder to elbow
export const FOREARM = 167.5;           // [ESTIMATE split of a REAL total] elbow to wrist centre
export const WRIST_TO_FLANGE = 25.0;    // [ESTIMATE] wrist centre to tool mounting face

export const TOOL_LENGTH = {
  MAGNET: 25.0,   // [ESTIMATE] Magnet Pickup Tool (VEX default tool [S3])
  PEN: 45.0,      // [ESTIMATE] Pen Holder Tool body; VEX adds the pen offset [S3]
  NONE: 0.0,
};
export const DEFAULT_PEN_OFFSET = 0.0;  // [REAL] VEX resets the pen offset to 0 [S3]
export const TYPICAL_PEN_OFFSET = 23.0; // [REAL] "approximately 23 mm" for the kit marker [S4]

// The advertised 335 mm maximum reach, read as the horizontal reach with the
// tool pointing down: UPPER_ARM + FOREARM = 335. [REAL total, ESTIMATED split] [S1]
export const MAX_REACH = 335.0;         // [REAL] [S1]

// VEX CTE platform footprint [REAL] [S1]; 50 mm grid like the real Tile [REAL] [S6].
export const PLATFORM_SIZE = [638.0, 333.0];      // width along X, depth along Y
export const PLATFORM_CENTER = [100.0, 0.0];      // [ESTIMATE] where the arm sits on it
// When the platform is resized the arm keeps this distance from the back (-X) edge.
export const PLATFORM_BACK_MARGIN = PLATFORM_SIZE[0] / 2 - PLATFORM_CENTER[0];   // 219 mm
export const PLATFORM_MIN = 200.0;
export const PLATFORM_MAX = 2000.0;
export const PLATFORM_PRESETS = [["VEX tile", 638.0, 333.0], ["Square", 500.0, 500.0], ["Large", 1000.0, 600.0]];

// Visual sizes only [ESTIMATE]
export const BASE_RADIUS = 55.0;
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

export const SAFE_POSITION = [120.0, 0.0, 100.0];   // [REAL] approx. VEX "safe position" [S2]
export const FLOOR_Z = 0.0;
export const FLOOR_MARGIN = 2.0;
export const BASE_KEEPOUT = [60.0, 110.0];          // wrist/tool may not enter (radius, height) [ESTIMATE]
