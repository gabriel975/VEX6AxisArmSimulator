"""
vex.py - Stand-in for VEXcode's `vex` / `cte` module, running in the browser
(Pyodide) so VEXcode CTE projects run unchanged on the simulated arm.
Port of six_axis_arm/vex.py: the API is the same, but the arm itself lives in
the page, so every Arm call is a message to the page (see simrt.py).

    from cte import *
    brain = Brain()
    arm = Arm()
    signal_tower = arm.signal_tower
    arm.move_to(120, 0, 100)

Arm API: https://api.vex.com/cte/home/python/Arm.html ,
https://api.vex.com/exp/home/python/Arm.html . Workcell devices (pneumatics,
sensors, motors ...) are safe stubs that log a [sim] note.
"""
import random as _random
import sys as _sys
import types as _types

import simrt as _simrt
from simrt import ProgramStopped  # noqa: F401  (re-exported for programs that catch it)

_rt = _simrt.rt


# ============================================================ brain screen ===
class _ScreenLog:
    """The Brain screen / console: rows of text with a cursor. Every change is
    also sent to the page, which keeps the same rows for the Brain screen panel."""
    MAX_ROWS = 300

    def __init__(self):
        self.rows = [""]
        self.row = 0
        self.col = 0

    def _op(self, op, *args):
        _rt.post(type="screen", op=op, args=list(args))

    def clear(self):
        self.rows, self.row, self.col = [""], 0, 0
        self._op("clear")

    def _ensure(self, row):
        while len(self.rows) <= row:
            self.rows.append("")

    def write(self, text):
        text = str(text)
        for ch in text:
            if ch == "\n":
                self._newline()
                continue
            self._ensure(self.row)
            line = self.rows[self.row]
            if len(line) < self.col:
                line += " " * (self.col - len(line))
            self.rows[self.row] = line[:self.col] + ch + line[self.col + 1:]
            self.col += 1
        self._op("write", text)

    def _newline(self):
        self._ensure(self.row)
        self.row += 1
        self.col = 0
        self._ensure(self.row)
        if len(self.rows) > self.MAX_ROWS:
            cut = len(self.rows) - self.MAX_ROWS
            self.rows = self.rows[cut:]
            self.row -= cut

    def newline(self):
        self._newline()
        self._op("newline")

    def set_cursor(self, row, col):
        self.row = max(0, int(row) - 1)
        self.col = max(0, int(col) - 1)
        self._ensure(self.row)
        self._op("set_cursor", row, col)

    def clear_row(self, row=None):
        r = self.row if row is None else max(0, int(row) - 1)
        self._ensure(r)
        self.rows[r] = ""
        self._op("clear_row", row)


_screen = _ScreenLog()
_noted = set()


def _note(msg):
    """A [sim] note in the Brain screen panel (not on the robot's screen)."""
    if msg in _noted and len(_noted) > 200:
        return
    _noted.add(msg)
    _rt.post(type="note", message=str(msg))


def _fmt(v):
    if isinstance(v, float):
        return f"{v:.2f}".rstrip("0").rstrip(".") if abs(v) < 1e15 else str(v)
    return str(v)


def _begin_program():
    global _screen
    _screen = _ScreenLog()
    _noted.clear()


# ============================================================== constants ===
class Ports:
    pass


for _i in range(1, 23):
    setattr(Ports, f"PORT{_i}", _i)

MM, INCHES, CM = "MM", "INCHES", "CM"
DEGREES, TURNS, RADIANS = "DEGREES", "TURNS", "RADIANS"
PERCENT, RPM, DPS, VOLT = "PERCENT", "RPM", "DPS", "VOLT"
MSEC, SECONDS, SEC = "MSEC", "SECONDS", "SECONDS"
MAGNET, PEN = "MAGNET", "PEN"
BOOST, DROP, ENGAGED, RELEASED = "BOOST", "DROP", "ENGAGED", "RELEASED"
FORWARD, REVERSE = "FORWARD", "REVERSE"
BRAKE, COAST, HOLD = "BRAKE", "COAST", "HOLD"
LEFT, RIGHT = "LEFT", "RIGHT"
CYLINDER1, CYLINDER2, CYLINDER3, CYLINDER4, CYLINDERALL = (
    "CYLINDER1", "CYLINDER2", "CYLINDER3", "CYLINDER4", "CYLINDERALL")
BLACK, WHITE, RED, GREEN, BLUE = "BLACK", "WHITE", "RED", "GREEN", "BLUE"
YELLOW, ORANGE, PURPLE, CYAN, TRANSPARENT = "YELLOW", "ORANGE", "PURPLE", "CYAN", "TRANSPARENT"
X_AXIS, Y_AXIS, Z_AXIS = "X_AXIS", "Y_AXIS", "Z_AXIS"
PITCH, ROLL, YAW = "PITCH", "ROLL", "YAW"


class _Namespace:
    def __init__(self, **kw):
        self.__dict__.update(kw)


TimeUnits = _Namespace(MSEC=MSEC, SECONDS=SECONDS, SEC=SECONDS)
DistanceUnits = _Namespace(MM=MM, INCHES=INCHES, CM=CM)
RotationUnits = _Namespace(DEG=DEGREES, REV=TURNS, RAW="RAW")
VelocityUnits = _Namespace(PERCENT=PERCENT, RPM=RPM, DPS=DPS)
PercentUnits = _Namespace(PERCENT=PERCENT)
DirectionType = _Namespace(FORWARD=FORWARD, REVERSE=REVERSE)
BrakeType = _Namespace(BRAKE=BRAKE, COAST=COAST, HOLD=HOLD)
FontType = _Namespace(MONO12="MONO12", MONO15="MONO15", MONO20="MONO20", MONO30="MONO30",
                      MONO40="MONO40", MONO60="MONO60", PROP20="PROP20", PROP30="PROP30",
                      PROP40="PROP40", PROP60="PROP60")


class Color:
    BLACK, WHITE, RED, GREEN, BLUE = BLACK, WHITE, RED, GREEN, BLUE
    YELLOW, ORANGE, PURPLE, CYAN, TRANSPARENT = YELLOW, ORANGE, PURPLE, CYAN, TRANSPARENT

    def __init__(self, *args):
        self.value = args


def _seconds(amount, units):
    return float(amount) / 1000.0 if str(units).upper() in ("MSEC", "MS") else float(amount)


# ============================================================== functions ===
async def wait(time, units=MSEC):  # noqa: A002 - VEX name
    """wait(time, units=MSEC) - like VEXcode (default unit is milliseconds)."""
    await _rt.sleep(_seconds(time, units))


async def sleep(duration, units=MSEC):
    await wait(duration, units)


def monitor_variable(*names):
    _note("monitor_variable" + str(names) + " (VEXcode Monitor tab not simulated)")


def monitor_sensor(*names):
    _note("monitor_sensor" + str(names) + " (VEXcode Monitor tab not simulated)")


def _vex_print(*values, sep=" ", end="\n", file=None, flush=False):
    """print() inside projects goes to the Brain screen."""
    _rt.check_stop()
    _screen.write(sep.join(_fmt(v) for v in values) + end)


def _vex_input(prompt=""):
    _rt.check_stop()
    if prompt:
        _screen.write(str(prompt))
    _note("input() is not supported in the simulator - returning ''")
    _screen.newline()
    return ""


# ========================================================= events/threads ===
class Event:
    """VEX Event: ev = Event(); ev(callback); ev.broadcast()"""

    def __init__(self, callback=None, arg=()):
        self._callbacks = []
        if callback is not None:
            self(callback, arg)

    def __call__(self, callback, arg=()):
        self._callbacks.append((callback, tuple(arg)))
        return self

    def broadcast(self):
        for cb, arg in list(self._callbacks):
            _rt.spawn(cb, arg)

    async def broadcast_and_wait(self, timeout=60000):
        import asyncio
        tasks = [_rt.spawn(cb, arg) for cb, arg in list(self._callbacks)]
        if tasks:
            await asyncio.wait(tasks)


def cte_thread(callback, arg=()):
    """VEXcode CTE template helper: run callback (usually main) as a thread."""
    return Thread(callback, arg)


class Thread:
    """VEX Thread: starts running callback right away (an asyncio task here)."""

    def __init__(self, callback, arg=()):
        self._t = _rt.spawn(callback, arg)

    def stop(self):
        if not self._t.done():
            self._t.cancel()

    @staticmethod
    async def sleep_for(duration, units=MSEC):
        await wait(duration, units)


class Timer:
    def __init__(self):
        self._start = _rt.now()

    def time(self, units=MSEC):
        t = _rt.now() - self._start
        return t * 1000.0 if str(units).upper() in ("MSEC", "MS") else t

    def value(self):
        return _rt.now() - self._start

    def clear(self):
        self._start = _rt.now()

    reset = clear

    def system(self):
        return int(_rt.now() * 1000)

    def system_high_res(self):
        return int(_rt.now() * 1_000_000)

    def event(self, callback, delay, arg=()):
        async def later():
            await wait(delay, MSEC)
            await _simrt._aw(callback(*arg))
        _rt.spawn(later)


# ================================================================== Brain ===
class _NoOp:
    """Accepts any method call and does nothing (notes the first use)."""

    def __init__(self, label):
        self._label = label
        self._seen = set()

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)

        def method(*args, **kwargs):
            if name not in self._seen:
                self._seen.add(name)
                _note(f"{self._label}.{name}() is not simulated (ignored)")
            return 0
        return method


class _Screen(_NoOp):
    """EXP-style brain.screen: print() does NOT add a new line."""

    def __init__(self):
        super().__init__("brain.screen")

    def print(self, *values, sep=" ", precision=None, **kw):
        _rt.check_stop()
        _screen.write(sep.join(_fmt(v) for v in values))

    def next_row(self):
        _screen.newline()

    new_line = next_row

    def clear_screen(self, color=None):
        _screen.clear()

    def clear_row(self, row=None, color=None):
        _screen.clear_row(row)

    def set_cursor(self, row, column):
        _screen.set_cursor(row, column)

    def row(self):
        return _screen.row + 1

    def column(self):
        return _screen.col + 1

    def set_font(self, *a, **k):
        pass

    def set_pen_color(self, *a, **k):
        pass

    def set_fill_color(self, *a, **k):
        pass

    def set_pen_width(self, *a, **k):
        pass

    def render(self, *a, **k):
        return True


class Brain(_NoOp):
    def __init__(self):
        super().__init__("brain")
        self.screen = _Screen()
        self.timer = Timer()
        self.battery = _NoOp("brain.battery")
        self.sdcard = _NoOp("brain.sdcard")

    def print(self, *values, sep=" ", end="\n", precision=None):
        _rt.check_stop()
        _screen.write(sep.join(_fmt(v) for v in values) + end)

    def new_line(self):
        _screen.newline()

    def clear(self):
        _screen.clear()

    def set_print_color(self, color):
        pass

    set_console_text_color = set_print_color

    def timer_time(self, units=MSEC):
        t = _rt.now() - _rt.brain_timer_start
        return t * 1000.0 if str(units).upper() in ("MSEC", "MS") else t

    def timer_reset(self):
        _rt.brain_timer_start = _rt.now()

    def program_stop(self):
        raise ProgramStopped()


# ==================================================================== Arm ===
def _units_k(units):
    u = str(units).upper()
    return 25.4 if u == "INCHES" else (10.0 if u == "CM" else 1.0)


class Arm:
    """Simulated VEX 6-Axis Arm. Arm() (CTE) or Arm(Ports.PORTx) (EXP)."""
    MAGNET = MAGNET
    PEN = PEN

    def __init__(self, smartport=None, *args, **kwargs):
        self.port = smartport
        self._timeout_ms = 30000          # [ESTIMATE] VEX doesn't document the default
        self._tower = None

    @property
    def signal_tower(self):
        if self._tower is None:
            self._tower = SignalTower()
        return self._tower

    @staticmethod
    def _mm(x, y, z, units):
        k = _units_k(units)
        return [float(x) * k, float(y) * k, float(z) * k]

    async def _move(self, kind, values, wait):
        await _rt.at_command()
        return bool(await _rt.call("arm", kind, values, bool(wait), self._timeout_ms))

    # ---- actions
    async def move_to(self, x, y, z, wait=True, units=MM):
        return await self._move("move_to", self._mm(x, y, z, units), wait)

    async def move_inc(self, x, y, z, wait=True, units=MM):
        return await self._move("move_inc", self._mm(x, y, z, units), wait)

    async def move_end_effector_to(self, yaw, roll=0, pitch=0, wait=True):
        return await self._move("move_end_effector_to", [float(yaw), float(roll), float(pitch)], wait)

    async def move_end_effector_inc(self, yaw, roll=0, pitch=0, wait=True):
        return await self._move("move_end_effector_inc", [float(yaw), float(roll), float(pitch)], wait)

    # ---- settings
    async def set_speed(self, speed, units=PERCENT):
        return await _rt.call("arm", "set_speed", [max(1, min(100, int(speed)))])

    async def set_end_effector_type(self, type):  # noqa: A002 - VEX name
        t = str(type).upper()
        if t not in ("MAGNET", "PEN"):
            raise ValueError("end effector type must be MAGNET or PEN")
        return await _rt.call("arm", "set_end_effector_type", [t])

    async def set_end_effector_magnet(self, state):
        on = state if isinstance(state, bool) else str(state).upper() in ("TRUE", "1", "BOOST", "ENGAGED", "ON")
        return await _rt.call("arm", "set_end_effector_magnet", [bool(on)])

    async def set_pen_offset(self, z_offset, units=MM):
        return await _rt.call("arm", "set_pen_offset", [float(z_offset) * (25.4 if str(units).upper() == "INCHES" else 1.0)])

    async def set_control_stop(self, state=True):
        if state:
            return await _rt.call("arm", "control_stop", [])

    def set_timeout(self, timeout, units=MSEC):
        self._timeout_ms = _seconds(timeout, units) * 1000.0

    def get_timeout(self):
        return self._timeout_ms

    # ---- getters
    async def _get(self, what, units=MM):
        return await _rt.call("arm", "get", [what, str(units).upper()])

    async def is_done(self):
        return bool(await self._get("is_done"))

    async def is_crashed(self):
        return bool(await self._get("is_crashed"))

    async def get_x(self, units=MM):
        return await self._get("x", units)

    async def get_y(self, units=MM):
        return await self._get("y", units)

    async def get_z(self, units=MM):
        return await self._get("z", units)

    async def get_yaw(self, units=DEGREES):
        return await self._get("yaw")

    async def get_roll(self, units=DEGREES):
        return await self._get("roll")

    async def get_pitch(self, units=DEGREES):
        return await self._get("pitch")

    async def can_arm_reach_to(self, x, y, z, units=MM):
        return bool(await _rt.call("arm", "can_reach", ["to", self._mm(x, y, z, units)]))

    async def can_arm_reach_inc(self, x, y, z, units=MM):
        return bool(await _rt.call("arm", "can_reach", ["inc", self._mm(x, y, z, units)]))

    async def can_end_effector_reach_to(self, yaw, roll=0, pitch=0):
        return bool(await _rt.call("arm", "can_reach", ["ee_to", [float(yaw), float(roll), float(pitch)]]))

    async def can_end_effector_reach_inc(self, yaw, roll=0, pitch=0):
        return bool(await _rt.call("arm", "can_reach", ["ee_inc", [float(yaw), float(roll), float(pitch)]]))

    def is_connected(self):
        return True

    def installed(self):
        return True

    # ---- callbacks
    def control_stopped(self, callback, arg=()):
        _rt.control_stop_callbacks.append((callback, tuple(arg)))
        return Event()

    def crashed(self, callback, arg=()):
        _rt.crash_callbacks.append((callback, tuple(arg)))
        return Event()


# ==================================================== workcell device stubs ===
class _Device:
    """Devices that aren't simulated: accept calls, note them."""
    KIND = "Device"

    def __init__(self, *args, **kwargs):
        self.port = next((a for a in args if isinstance(a, int)), None)

    @property
    def _name(self):
        return f"{self.KIND}" + (f"(PORT{self.port})" if self.port else "")

    def _log(self, what):
        _rt.check_stop()
        _note(f"{self._name}: {what} (stub)")

    def installed(self):
        return True

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)

        def method(*args, **kwargs):
            self._log(f"{name}({', '.join(_fmt(a) for a in args)})")
            return 0
        return method


class SignalTower(_Device):
    KIND = "SignalTower"
    RED, YELLOW, GREEN, BLUE, WHITE, ALL = "RED", "YELLOW", "GREEN", "BLUE", "WHITE", "ALL"
    ON, OFF, BLINK = "ON", "OFF", "BLINK"

    def set_color(self, value, state=None):
        state = "ON" if state is None else str(state).upper()
        _rt.post(type="tower", colors=[str(value).upper()], state=state)

    def set_colors(self, r, y, g, b, w):
        for k, s in zip(("RED", "YELLOW", "GREEN", "BLUE", "WHITE"), (r, y, g, b, w)):
            _rt.post(type="tower", colors=[k], state=str(s).upper())

    def pressing(self):
        return False

    def pressed(self, callback, arg=()):
        _rt.tower_pressed.append((callback, tuple(arg)))
        return Event()

    def released(self, callback, arg=()):
        _rt.tower_released.append((callback, tuple(arg)))
        return Event()


class Pneumatic(_Device):
    KIND = "Pneumatic"

    def pump_on(self):
        self._log("pump on")

    def pump_off(self):
        self._log("pump off")

    def pump(self, state):
        self._log(f"pump {'on' if state else 'off'}")

    def extend(self, cylinder=CYLINDERALL):
        self._log(f"extend {cylinder}")

    def retract(self, cylinder=CYLINDERALL):
        self._log(f"retract {cylinder}")


class _Sensor(_Device):
    """Sensors read 'nothing there'; callbacks are accepted but never fire."""

    def _register(self, callback, arg=()):
        return Event()

    pressed = released = object_detected = object_lost = gesture_detected = changed = _register

    def pressing(self):
        return False


class Bumper(_Sensor):
    KIND = "Bumper"


class Optical(_Sensor):
    KIND = "Optical"

    def is_near_object(self):
        return False

    def color(self):
        return BLACK

    def hue(self):
        return 0.0

    def brightness(self, *a):
        return 0.0

    def set_light(self, *a):
        pass

    def set_light_power(self, *a, **k):
        pass

    def object_detect_threshold(self, *a):
        pass


class Distance(_Sensor):
    KIND = "Distance"

    def object_distance(self, units=MM):
        return 9999.0

    def is_object_detected(self):
        return False

    def object_size(self):
        return "NONE"

    def object_velocity(self):
        return 0.0


class Motor(_Device):
    KIND = "Motor"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._vel = 50.0
        self._spinning = False
        self._pos = 0.0

    def spin(self, direction=FORWARD, velocity=None, units=PERCENT):
        self._spinning = True
        self._log(f"spin {direction}")

    def spin_for(self, direction, amount, units=DEGREES, *a, **k):
        self._pos += float(amount) * (1 if str(direction).upper() == "FORWARD" else -1)
        self._log(f"spin_for {direction} {_fmt(amount)} {units}")

    def spin_to_position(self, rotation, units=DEGREES, *a, **k):
        self._pos = float(rotation)
        self._log(f"spin_to_position {_fmt(rotation)} {units}")

    def stop(self, mode=None):
        if self._spinning:
            self._log("stop")
        self._spinning = False

    def set_velocity(self, velocity, units=PERCENT):
        self._vel = float(velocity)

    def set_stopping(self, mode):
        pass

    def set_position(self, value, units=DEGREES):
        self._pos = float(value)

    def set_timeout(self, *a, **k):
        pass

    def position(self, units=DEGREES):
        return self._pos

    def velocity(self, units=PERCENT):
        return self._vel if self._spinning else 0.0

    def is_spinning(self):
        return self._spinning

    def is_done(self):
        return True

    def current(self, *a):
        return 0.0


class MotorGroup(Motor):
    KIND = "MotorGroup"


class ConveyorBelt(Motor):
    KIND = "Conveyor"


def _simple_stub(kind):
    return type(kind, (_Sensor,), {"KIND": kind})


TouchLED = _simple_stub("TouchLED")
Inertial = _simple_stub("Inertial")
Gyro = _simple_stub("Gyro")
Rotation = _simple_stub("Rotation")
Potentiometer = _simple_stub("Potentiometer")
Controller = _simple_stub("Controller")
DigitalIn = _simple_stub("DigitalIn")
DigitalOut = _simple_stub("DigitalOut")
Competition = _simple_stub("Competition")
EjectionSensor = _simple_stub("EjectionSensor")
LineTracker = _simple_stub("LineTracker")
Vision = _simple_stub("Vision")
AiVision = _simple_stub("AiVision")


# ====================================================== urandom / aliases ===
_urandom = _types.ModuleType("urandom")
for _n in ("getrandbits", "randint", "random", "uniform", "choice", "seed", "randrange"):
    setattr(_urandom, _n, getattr(_random, _n))
_sys.modules.setdefault("urandom", _urandom)
_sys.modules.setdefault("vex", _sys.modules[__name__])

__all__ = [n for n, v in list(globals().items())
           if not n.startswith("_") and not isinstance(v, _types.ModuleType)
           and n not in ("annotations", "ProgramStopped")]


def _make_namespace(filename):
    """Globals for the student's program: builtins, the vex API pre-imported,
    print()/input() going to the Brain screen, default brain/arm objects."""
    import builtins
    ns = {"__name__": "__main__", "__file__": filename, "__builtins__": builtins}
    g = globals()
    for n in __all__:
        ns[n] = g[n]
    ns["print"] = _vex_print
    ns["input"] = _vex_input
    ns["brain"] = Brain()
    ns["arm"] = Arm()
    ns["arm1"] = ns["arm"]
    return ns
