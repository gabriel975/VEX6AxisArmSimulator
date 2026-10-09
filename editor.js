// editor.js - the code editor (CodeMirror 6, vendored) with the running /
// paused / error line highlighted, like the v4 editor.
import {
  EditorView, keymap, Decoration, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars,
  EditorState, StateField, StateEffect, defaultKeymap, history, historyKeymap, indentWithTab,
  toggleComment, indentUnit, syntaxHighlighting, defaultHighlightStyle, HighlightStyle, bracketMatching,
  indentOnInput, foldGutter, foldKeymap, searchKeymap, highlightSelectionMatches, closeBrackets,
  closeBracketsKeymap, python, tags,
} from "../vendor/codemirror.js";

const setMarks = StateEffect.define();
const marks = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setMarks)) deco = e.value;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const style = HighlightStyle.define([
  { tag: tags.keyword, color: "#7c3aed", fontWeight: "600" },
  { tag: [tags.string, tags.special(tags.string)], color: "#15803d" },
  { tag: tags.comment, color: "#8a94a6", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.null], color: "#c2410c" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#1d4ed8" },
  { tag: tags.definition(tags.variableName), color: "#0f172a" },
  { tag: tags.className, color: "#b45309" },
  { tag: tags.operator, color: "#475569" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "#fff" },
  ".cm-scroller": { fontFamily: "'JetBrains Mono', ui-monospace, monospace", lineHeight: "1.55" },
  ".cm-gutters": { backgroundColor: "#f8f9fb", color: "#9aa1ad", borderRight: "1px solid #e2e5eb" },
  ".cm-activeLineGutter": { backgroundColor: "#eef1f6" },
  ".cm-activeLine": { backgroundColor: "#f5f7fb" },
  "&.cm-focused": { outline: "none" },
  ".cm-line.exec-line": { backgroundColor: "#dbeafe", boxShadow: "inset 3px 0 0 #2563eb" },
  ".cm-line.exec-paused": { backgroundColor: "#fef3c7", boxShadow: "inset 3px 0 0 #d97706" },
  ".cm-line.error-line": { backgroundColor: "#fee2e2", boxShadow: "inset 3px 0 0 #dc2626" },
});

export class CodeEditor {
  constructor(parent, { onRun, onSave, onChange, onEscape } = {}) {
    this.name = "untitled.ctepython";
    this.raw = null;           // the loaded VEXcode JSON object (kept for saving)
    this.fmt = "json";
    this.modified = false;
    this.execLine = null; this.execPaused = false; this.errorLine = null;
    this.onChange = onChange;
    const runKeys = [
      { key: "Mod-Enter", run: () => { onRun?.(); return true; } },
      { key: "F5", run: () => { onRun?.(); return true; } },
      { key: "Mod-s", run: () => { onSave?.(); return true; }, preventDefault: true },
      { key: "Mod-/", run: toggleComment },
      { key: "Escape", run: (v) => { v.contentDOM.blur(); onEscape?.(); return true; } },
    ];
    this._keys = runKeys;
    this.view = new EditorView({ parent, state: this.makeState("") });
  }

  makeState(doc) {
    return EditorState.create({
      doc,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(),
        drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true), indentOnInput(),
        syntaxHighlighting(style), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(), closeBrackets(), rectangularSelection(), crosshairCursor(),
        highlightActiveLine(), highlightSelectionMatches(), indentUnit.of("    "), EditorState.tabSize.of(4),
        keymap.of([...(this._keys || []), ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap,
          ...historyKeymap, ...foldKeymap, indentWithTab]),
        python(), marks, theme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            this.modified = true;
            if (this.errorLine) { this.errorLine = null; this.refresh(); }
            this.onChange?.();
          }
        }),
      ],
    });
  }

  get text() { return this.view.state.doc.toString(); }

  open(text, { name = "untitled.ctepython", raw = null, fmt = "json" } = {}) {
    this.name = name; this.raw = raw; this.fmt = fmt;
    this.execLine = this.errorLine = null;
    this.view.setState(this.makeState(text));
    this.modified = false;
    this.onChange?.();
  }

  refresh() {
    const doc = this.view.state.doc;
    const ranges = [];
    const add = (n, cls) => { if (n && n >= 1 && n <= doc.lines) ranges.push(Decoration.line({ class: cls }).range(doc.line(n).from)); };
    if (this.execLine) add(this.execLine, this.execPaused ? "exec-paused" : "exec-line");
    if (this.errorLine && this.errorLine !== this.execLine) add(this.errorLine, "error-line");
    ranges.sort((a, b) => a.from - b.from);
    this.view.dispatch({ effects: setMarks.of(Decoration.set(ranges)) });
  }

  scrollTo(n) {
    const doc = this.view.state.doc;
    if (!n || n < 1 || n > doc.lines) return;
    this.view.dispatch({ effects: EditorView.scrollIntoView(doc.line(n).from, { y: "center" }) });
  }

  setExec(line, paused) {
    if (line === this.execLine && paused === this.execPaused) return;
    const moved = line !== this.execLine;
    this.execLine = line; this.execPaused = paused;
    this.refresh();
    if (line && (moved || paused)) this.scrollTo(line);
  }

  setError(line) {
    this.errorLine = line;
    this.refresh();
    if (line) this.scrollTo(line);
  }

  focus() { this.view.focus(); }
  get hasFocus() { return this.view.hasFocus; }
}
