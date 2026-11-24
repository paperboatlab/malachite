// The Edit view: the note's Markdown in CodeMirror 6. One view per note; its text is the record, so the
// page saves what you type (debounced) and on Ctrl+S. A sealed note opens read-only.
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useRef } from "react";

// quiet: weight for structure, muted for markup and the front matter; no colours (the accent is not for text)
const style = HighlightStyle.define([
  { tag: t.heading, fontWeight: "600" }, { tag: t.strong, fontWeight: "600" }, { tag: t.emphasis, fontStyle: "italic" },
  { tag: [t.processingInstruction, t.meta, t.url, t.comment, t.contentSeparator, t.definition(t.propertyName), t.propertyName], color: "var(--text-muted)" },
  { tag: t.link, textDecoration: "underline", textDecorationColor: "var(--line-strong)" }, { tag: t.monospace, color: "var(--text-muted)" },
  { tag: [t.string, t.number, t.bool], color: "var(--text)" }, { tag: t.keyword, fontWeight: "600" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", background: "transparent", color: "var(--text)", fontSize: "13px" },
  ".cm-content": { fontFamily: "var(--font-mono)", padding: "24px 0", maxWidth: "760px", margin: "0 auto", caretColor: "var(--text)" },
  ".cm-scroller": { lineHeight: "1.65" },
  "&.cm-focused": { outline: "none" },
  ".cm-line": { padding: "0 40px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { background: "color-mix(in srgb, var(--accent) 22%, transparent) !important" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
});

export function Editor({ text, readOnly, onChange, onSave }: { text: string; readOnly: boolean; onChange: (t: string) => void; onSave: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };

  useEffect(() => {
    const v = new EditorView({
      parent: box.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          history(), yamlFrontmatter({ content: markdown() }), syntaxHighlighting(style), EditorView.lineWrapping, theme,
          EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
          keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { cb.current.onSave(); return true; } }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange(u.state.doc.toString()); }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // a new view per note and per seal state; outside changes arrive below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // the file changed underneath (another editor, git): take it, unless it is what we typed
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== text) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
  }, [text]);

  return <div className="editor" ref={box} />;
}
