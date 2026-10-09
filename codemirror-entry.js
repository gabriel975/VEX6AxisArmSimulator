// Entry for the vendored CodeMirror 6 bundle (built once with esbuild; the site itself has no build step).
export { EditorView, keymap, Decoration, gutter, GutterMarker, lineNumbers, highlightActiveLine,
         highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection,
         crosshairCursor, highlightSpecialChars, ViewPlugin } from "@codemirror/view";
export { EditorState, StateField, StateEffect, RangeSetBuilder, Compartment } from "@codemirror/state";
export { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment, undo, redo } from "@codemirror/commands";
export { indentUnit, syntaxHighlighting, defaultHighlightStyle, HighlightStyle, bracketMatching,
         indentOnInput, foldGutter, foldKeymap } from "@codemirror/language";
export { searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
export { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
export { python } from "@codemirror/lang-python";
export { tags } from "@lezer/highlight";
