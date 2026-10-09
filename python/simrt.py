"""
simrt.py - Runs a student's VEXcode Python program inside Pyodide (in a Web Worker).

How the program can "block" without SharedArrayBuffer
------------------------------------------------------
GitHub Pages can't send the COOP/COEP headers that SharedArrayBuffer needs, so
we don't use it. Instead the program is rewritten (with Python's own `ast`
module) before it runs:

* every `def` becomes `async def` (except __dunder__ methods, generators and
  @property functions, which must stay normal functions),
* every function call `f(x)` becomes `await __simrt_aw__(f(x))` - it awaits the
  result only if it is awaitable, so normal calls like len() work as before,
* before every statement `await __simrt_line__(<line number>)` is inserted.
  That one hook gives us: the running-line highlight, Pause, Step line, Stop,
  and it lets the browser breathe during long loops.

Arm calls (arm.move_to etc.) send a message to the page, which runs the 3D arm,
and `await` the reply - so arm.move_to() still "waits until the move is done"
exactly like on the real arm. wait() awaits a timer on the program clock (scaled
by the sim speed, frozen while paused). Threads (cte_thread / Thread / Event)
are asyncio tasks.

The page talks to us through BRIDGE (set up by py_worker.js):
    BRIDGE.post(json_text)              - message to the page
    await BRIDGE.call(name, json_args)  - request/reply with the page (returns JSON text)
    BRIDGE.clock()                      - real time in seconds
and calls on_message(json_text) for pause / resume / step / speed / stop / ...
"""
import ast
import asyncio
import inspect
import json
import sys
import traceback

FILENAME = "<project>"
LINE = "__simrt_line__"
AW = "__simrt_aw__"


class ProgramStopped(BaseException):
    """Raised in the program when Stop is pressed (BaseException so a student's
    `except Exception:` can't swallow it)."""


class _Bridge:
    post = staticmethod(lambda text: None)
    call = None
    clock = None


BRIDGE = _Bridge()


# ============================================================== transform ===
_KEEP_SYNC_DECORATORS = {"property", "setter", "getter", "deleter", "contextmanager",
                         "staticmethod_sync"}


def _is_generator(fn):
    stack = list(fn.body)
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.Yield, ast.YieldFrom)):
            return True
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            continue
        stack.extend(ast.iter_child_nodes(node))
    return False


def _keep_sync(fn):
    if fn.name.startswith("__") and fn.name.endswith("__"):
        return True
    for d in fn.decorator_list:
        n = d.id if isinstance(d, ast.Name) else (d.attr if isinstance(d, ast.Attribute) else "")
        if n in _KEEP_SYNC_DECORATORS:
            return True
    return _is_generator(fn)


class _Transformer(ast.NodeTransformer):
    def __init__(self):
        self.scopes = ["async"]          # module level runs with top-level await

    @property
    def is_async(self):
        return self.scopes[-1] == "async"

    def _hook(self, node):
        call = ast.Call(ast.Name(LINE, ast.Load()), [ast.Constant(node.lineno)], [])
        stmt = ast.Expr(ast.Await(call))
        return ast.copy_location(stmt, node)

    def stmts(self, body):
        out = []
        for s in body:
            hook = self.is_async and not (isinstance(s, ast.ImportFrom) and s.module == "__future__")
            r = self.visit(s)
            if hook:
                out.append(self._hook(s))
            if r is None:
                continue
            out.extend(r if isinstance(r, list) else [r])
        return out or [ast.Pass()]

    def generic_visit(self, node):
        for field, value in ast.iter_fields(node):
            if isinstance(value, list) and value and isinstance(value[0], ast.stmt) \
                    and field in ("body", "orelse", "finalbody"):
                setattr(node, field, self.stmts(value))
            elif isinstance(value, list):
                new = []
                for v in value:
                    if isinstance(v, ast.AST):
                        r = self.visit(v)
                        if r is None:
                            continue
                        new.extend(r if isinstance(r, list) else [r])
                    else:
                        new.append(v)
                value[:] = new
            elif isinstance(value, ast.AST):
                setattr(node, field, self.visit(value))
        return node

    def _function(self, node, make_async):
        # decorators, defaults and annotations belong to the enclosing scope
        node.decorator_list = [self.visit(d) for d in node.decorator_list]
        node.args = self.visit(node.args)
        if node.returns is not None:
            node.returns = self.visit(node.returns)
        self.scopes.append("async" if make_async else "sync")
        node.body = self.stmts(node.body)
        self.scopes.pop()
        if make_async and isinstance(node, ast.FunctionDef):
            new = ast.AsyncFunctionDef(name=node.name, args=node.args, body=node.body,
                                       decorator_list=node.decorator_list, returns=node.returns,
                                       type_comment=getattr(node, "type_comment", None),
                                       type_params=getattr(node, "type_params", []))
            return ast.copy_location(new, node)
        return node

    def visit_FunctionDef(self, node):
        return self._function(node, not _keep_sync(node))

    def visit_AsyncFunctionDef(self, node):
        return self._function(node, True)

    def _sync_scope(self, node):
        self.scopes.append("sync")
        node = self.generic_visit(node)
        self.scopes.pop()
        return node

    visit_Lambda = _sync_scope

    def visit_GeneratorExp(self, node):
        # In async code a generator expression would become an async generator that
        # sum() / any() / list() can't use, so it is run as a list comprehension
        # instead (same result; it is just not lazy).
        if not self.is_async:
            return self._sync_scope(node)
        comp = ast.copy_location(ast.ListComp(elt=node.elt, generators=node.generators), node)
        return self.generic_visit(comp)

    def visit_ClassDef(self, node):
        node.decorator_list = [self.visit(d) for d in node.decorator_list]
        node.bases = [self.visit(b) for b in node.bases]
        self.scopes.append("sync")          # a class body can't await
        node.body = self.stmts(node.body)
        self.scopes.pop()
        return node

    def visit_Call(self, node):
        self.generic_visit(node)
        if self.is_async:
            wrapped = ast.Await(ast.Call(ast.Name(AW, ast.Load()), [node], []))
            return ast.copy_location(wrapped, node)
        return node


def transform(source):
    """Source text -> code object ready to eval (may raise SyntaxError)."""
    tree = ast.parse(source, FILENAME, "exec")
    tree = _Transformer().visit(tree)
    ast.fix_missing_locations(tree)
    return compile(tree, FILENAME, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT, dont_inherit=True)


async def _aw(value):
    if inspect.isawaitable(value):
        return await value
    return value


# ================================================================ runtime ===
class Runtime:
    def __init__(self):
        self.time_scale = 1.0
        self.paused = False
        self._vt = 0.0
        self._vlast = None
        self.running = False
        self.reset()

    def reset(self):
        self.stopping = False
        self.error = None
        self.error_line = None
        self.current_line = None
        self.paused_at = ""
        self._step_req = None
        self._stop_next_line = False
        self._stop_next_command = False
        self.tasks = []
        self.main_task = None
        self.brain_timer_start = 0.0
        self.control_stop_callbacks = []
        self.crash_callbacks = []
        self.tower_pressed = []
        self.tower_released = []
        self.source_lines = []
        self._last_line_post = 0.0
        self._posted_line = None
        self._last_yield = 0.0

    # ---- messages
    def post(self, **msg):
        BRIDGE.post(json.dumps(msg))

    async def call(self, name, *args):
        self.check_stop()
        text = await BRIDGE.call(name, json.dumps(list(args)))
        self.check_stop()
        return json.loads(str(text)) if text is not None else None

    # ---- clock
    def real(self):
        return float(BRIDGE.clock())

    def vclock(self):
        t = self.real()
        if self._vlast is None:
            self._vlast = t
        if not self.paused:
            self._vt += (t - self._vlast) * self.time_scale
        self._vlast = t
        return self._vt

    def now(self):
        return self.vclock()

    def set_time_scale(self, s):
        self.vclock()
        self.time_scale = float(min(10.0, max(0.1, s)))

    # ---- pause / step
    def _set_paused(self, on, why=""):
        self.vclock()
        self.paused = on
        self.paused_at = why if on else ""
        self.post(type="paused", paused=on, why=self.paused_at, line=self.current_line)

    def pause(self, why="user"):
        self._set_paused(True, why)

    def resume(self):
        self._stop_next_line = self._stop_next_command = False
        self._step_req = None
        if self.paused:
            self._set_paused(False)

    def step(self, kind):
        if self.paused:
            self._step_req = kind
        elif kind == "line":
            self._stop_next_line = True
        else:
            self._stop_next_command = True

    async def _wait_while_paused(self):
        while self.paused:
            self.check_stop()
            if self._step_req:
                kind, self._step_req = self._step_req, None
                if kind == "line":
                    self._stop_next_line = True
                else:
                    self._stop_next_command = True
                self._set_paused(False)
                return
            await asyncio.sleep(0.03)

    def check_stop(self):
        if self.stopping:
            raise ProgramStopped()

    async def line(self, n):
        """Called before every statement of the student's program."""
        self.check_stop()
        self.current_line = n
        if self._stop_next_line:
            self._stop_next_line = False
            self.pause("line")
        if self.paused:
            self._post_line(n, force=True)
            await self._wait_while_paused()
        t = self.real()
        self._post_line(n, t=t)
        if t - self._last_yield > 0.015:          # let the page (and Stop) through
            self._last_yield = t
            await asyncio.sleep(0)
            self.check_stop()

    def _post_line(self, n, force=False, t=None):
        if n == self._posted_line and not force:
            return
        t = self.real() if t is None else t
        if force or t - self._last_line_post > 0.04:
            self._last_line_post = t
            self._posted_line = n
            self.post(type="line", line=n)

    async def at_command(self):
        """Before every arm move (Step move stops here)."""
        self.check_stop()
        if self._stop_next_command:
            self._stop_next_command = False
            self.pause("command")
        if self.paused:
            self._post_line(self.current_line, force=True)
            await self._wait_while_paused()

    async def sleep(self, seconds):
        self.check_stop()
        if seconds <= 0:
            await asyncio.sleep(0)
            return
        end = self.vclock() + seconds
        while True:
            left = end - self.vclock()
            if left <= 0:
                break
            await asyncio.sleep(min(0.02, max(0.001, left / max(self.time_scale, 0.1))))
            self.check_stop()

    # ---- messages from the page
    def on_message(self, text):
        m = json.loads(str(text))
        kind = m.get("type")
        if kind == "pause":
            if self.running and not self.paused:
                self.pause("user")
        elif kind == "resume":
            self.resume()
        elif kind == "step":
            self.step(m.get("kind", "line"))
        elif kind == "speed":
            self.set_time_scale(m.get("scale", 1.0))
        elif kind == "stop":
            self.stop_all()
        elif kind == "tower_press":
            if self.tower_pressed:
                for cb, arg in list(self.tower_pressed) + list(self.tower_released):
                    self.spawn(cb, arg)
            else:
                self.post(type="tower_unhandled")
        elif kind == "control_stopped":
            for cb, arg in list(self.control_stop_callbacks):
                self.spawn(cb, arg)

    # ---- tasks ("threads")
    def spawn(self, fn, arg=()):
        task = asyncio.ensure_future(self._task_main(fn, tuple(arg)))
        self.tasks.append(task)
        return task

    async def _task_main(self, fn, arg):
        try:
            await _aw(fn(*arg))
        except (ProgramStopped, asyncio.CancelledError):
            pass
        except BaseException as e:      # noqa: BLE001 - report any student error
            self.report_error(e)

    def stop_all(self, exclude=None):
        self.stopping = True
        for t in [self.main_task] + list(self.tasks):
            if t is not None and t is not exclude and not t.done():
                t.cancel()

    def format_error(self, exc):
        if isinstance(exc, SyntaxError) and exc.filename == FILENAME:
            line, msg = exc.lineno, f"SyntaxError: {exc.msg}"
        else:
            line = None
            for fr in traceback.extract_tb(exc.__traceback__):
                if fr.filename == FILENAME:
                    line = fr.lineno
            msg = f"{type(exc).__name__}: {exc}"
            if "coroutine" in str(exc):
                # see the README: functions you write become async in the simulator
                msg += (" (the simulator can't let Python itself call a function you wrote,"
                        " e.g. sorted(key=my_function) or map(my_function, ...); use a lambda"
                        " or a loop instead)")
        if line:
            code = self.source_lines[line - 1].strip() if 0 < line <= len(self.source_lines) else ""
            return f"Line {line}: {msg}" + (f"   [{code[:60]}]" if code else ""), line
        return msg, None

    def report_error(self, exc):
        if self.error is None:
            self.error, self.error_line = self.format_error(exc)
            self.post(type="error", message=self.error, line=self.error_line)
        try:
            current = asyncio.current_task()
        except RuntimeError:
            current = None
        self.stop_all(exclude=current)

    async def run(self, source, name="project", start_paused=False):
        """Run a whole program; posts {"type": "done", "state": ...} at the end."""
        import vex
        self.reset()
        self.running = True
        self.source_lines = source.splitlines()
        self._vt, self._vlast = 0.0, None
        self.paused = bool(start_paused)
        self.paused_at = "line" if start_paused else ""
        self.brain_timer_start = 0.0
        vex._begin_program()
        self.post(type="started", paused=self.paused)
        state = "finished"
        try:
            code = transform(source)
        except SyntaxError as e:
            self.report_error(e)
            code = None
        if code is not None:
            ns = vex._make_namespace(FILENAME)
            ns[LINE] = self.line
            ns[AW] = _aw

            async def main():
                try:
                    result = eval(code, ns)
                    if inspect.isawaitable(result):
                        await result
                except (ProgramStopped, asyncio.CancelledError):
                    pass
                except BaseException as e:      # noqa: BLE001
                    self.report_error(e)

            self.main_task = asyncio.ensure_future(main())
            while True:
                pending = [t for t in [self.main_task] + self.tasks if not t.done()]
                if not pending:
                    break
                await asyncio.wait(pending)
        if self.error:
            state = "error"
        elif self.stopping:
            state = "stopped"
        self.running = False
        self.paused = False
        self.current_line = None
        self.post(type="done", state=state, error=self.error, line=self.error_line)
        return state


rt = Runtime()


def start(source, name="project", start_paused=False):
    """Start a program (returns right away; progress arrives as messages)."""
    return asyncio.ensure_future(rt.run(source, name, start_paused))


def on_message(text):
    rt.on_message(text)
