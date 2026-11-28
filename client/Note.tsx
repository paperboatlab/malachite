// A note: its properties (the front matter, time and author set by the app), then the body. Read shows
// it rendered with its cells runnable in place; Edit is the Markdown itself.
import { Icon, Key, RemoveKey, Spinner, loadMath, mathLoaded, type IconName, type MenuEntry } from "@paperboatlab/ui";
import { Editor, julia, python, type EditorSettings } from "@paperboatlab/ui/editor";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Cell, NoteData, Output, Props, Run } from "./api.ts";
import { renderer, type Resolve } from "./markdown.ts";
import { MenuChip } from "./MenuChip.tsx";

const PROPS: Record<string, [IconName, string]> = {
  created: ["calendar", "created"], author: ["person", "author"], project: ["symbol-namespace", "project"], kind: ["symbol-class", "kind"],
  status: ["pass", "status"], tags: ["tag", "tags"], run: ["pulse", "run"], sealed: ["lock", "sealed"],
};
const HIDE = new Set(["id", "title", "hash", "sealed_by"]);
/** "2026-11-17T14:03:00Z" as "2026-11-17 14:03 UTC"; anything else as written. */
const when = (v: string) => (/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?Z$/.test(v) ? `${v.slice(0, 10)} ${v.slice(11, 16)} UTC` : v);

function Properties({ props, intact }: { props: Props; intact?: boolean }) {
  const keys = Object.keys(props).filter((k) => !HIDE.has(k));
  if (!keys.length) return null;
  return (
    <dl className="props">
      {keys.map((k) => {
        const v = props[k];
        const [icon, label] = PROPS[k] ?? ["info", k];
        return [
          <dt key={`${k}-t`}><Icon name={icon} size={14} />{label}</dt>,
          <dd key={`${k}-d`}>
            {Array.isArray(v) ? v.map((x) => <span key={x} className="tg">{k === "tags" ? `#${x}` : x}</span>)
              : k === "kind" || k === "status" ? <span className="st">{v}</span>
              : k === "sealed" ? <><span className="v">{when(v)}</span><span className="auto">by {String(props.sealed_by ?? "")}{intact === false ? " · the body no longer matches its hash" : ""}</span></>
              : <span className="v">{when(v)}</span>}
            {(k === "created") && <span className="auto">set by Malachite</span>}
          </dd>,
        ];
      })}
    </dl>
  );
}

// the properties Malachite sets itself (they show, they don't edit), and the ones offered to add
const SYSTEM = new Set(["created", "author", "sealed"]);
const COMMON = ["kind", "status", "project", "tags", "due", "assignee"];
const today = () => new Date().toISOString().slice(0, 10);
export type AskFn = (title: string, value: string, ok: string, run: (v: string) => void) => void;

/** Live's properties: Read's table, editable. Every change is the note's front matter, rewritten. */
export function PropsEditor({ props, sealed, choices, ask, onChange }: {
  props: Props; sealed: boolean; choices: (key: string) => string[]; ask: AskFn; onChange: (next: Props) => void;
}) {
  const keys = Object.keys(props).filter((k) => !HIDE.has(k));
  const set = (k: string, v: string | string[]) => {
    const n = { ...props };
    if (v === "" || (Array.isArray(v) && !v.length)) delete n[k]; else n[k] = v;
    onChange(n);
  };
  const add = (k: string) => {
    if (k === "tags") return ask("Add a tag", "", "Add", (t) => set("tags", [t.replace(/^#/, "")]));
    if (k === "due") return set("due", today());
    const known = choices(k);
    if (known.length && (k === "kind" || k === "status")) return set(k, known[0]);
    ask(`Set ${k}`, "", "Set", (v) => set(k, v));
  };
  const other = () => ask("Add a property", "", "Add", (line) => {
    const m = /^\s*([A-Za-z_][\w-]*)\s*[:=]?\s*(.*)$/.exec(line);
    if (m && !HIDE.has(m[1]) && !SYSTEM.has(m[1])) set(m[1], m[2].trim() || today());
  });
  return (
    <dl className="props editable">
      {keys.map((k) => {
        const v = props[k], [icon, label] = PROPS[k] ?? ["info", k], fixed = sealed || SYSTEM.has(k);
        const rm = !fixed && <span className="prm"><RemoveKey label={`Remove ${k}`} onClick={() => set(k, "")} /></span>;
        return [
          <dt key={`${k}-t`}><Icon name={icon} size={14} />{label}</dt>,
          <dd key={`${k}-d`}>
            {fixed ? (Array.isArray(v) ? v.map((x) => <span key={x} className="tg">{x}</span>) : <span className="v">{when(v)}</span>)
              : Array.isArray(v) ? <>
                  {v.map((x) => <span key={x} className="tg">{k === "tags" ? `#${x}` : x}<RemoveKey label={`Remove ${x}`} onClick={() => set(k, v.filter((y) => y !== x))} /></span>)}
                  <button type="button" className="tg add" onClick={() => ask(k === "tags" ? "Add a tag" : `Add to ${k}`, "", "Add", (t) => set(k, [...v, t.replace(/^#/, "")]))}>+</button>
                </>
              : k === "kind" || k === "status" ? <MenuChip label={`Set ${k}`} className="st pick" menu={[
                  ...[...new Set([...choices(k), v])].map((x): MenuEntry => ({ id: x, label: x, checked: x === v, run: () => set(k, x) })),
                  "-", { id: "other", label: "Other…", run: () => ask(`Set ${k}`, v, "Set", (x) => set(k, x)) },
                ]}>{v}<Icon name="chevron-down" size={10} /></MenuChip>
              : <input key={v} className="pv" defaultValue={v} aria-label={k} type={/^\d{4}-\d\d-\d\d$/.test(v) ? "date" : "text"}
                  onBlur={(e) => e.target.value !== v && set(k, e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />}
            {k === "created" && <span className="auto">set by Malachite</span>}
            {rm}
          </dd>,
        ];
      })}
      {!sealed && <dd className="padd"><MenuChip label="Add a property" className="chip add" menu={[
        ...COMMON.filter((k) => !(k in props)).map((k): MenuEntry => ({ id: k, label: k, run: () => add(k) })),
        "-", { id: "other", label: "Other…", run: other },
      ]}>Add property</MenuChip></dd>}
    </dl>
  );
}

function Out({ o }: { o: Output }) {
  if (o.type === "stream") return <pre className={`stream ${o.name}`}>{o.text}</pre>;
  if (o.type === "error") return <pre className="err"><b>{o.error.type ? `${o.error.type}: ` : ""}{o.error.message}</b>{o.error.traceback ? `\n${o.error.traceback}` : ""}</pre>;
  const d = o.data;
  // a picture shows itself; HTML from a runtime is not trusted in the page, its text stands in
  if (d["image/png"]) return <div className="screen"><img alt={d["text/plain"] ?? "image"} src={`data:image/png;base64,${d["image/png"]}`} /></div>;
  if (d["image/svg+xml"]) return <div className="screen paper pb-paper-light"><img alt={d["text/plain"] ?? "image"} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(d["image/svg+xml"])}`} /></div>;
  return <pre className="val">{d["text/plain"] ?? ""}</pre>;
}

export type CodeLook = { settings: EditorSettings; appTheme: "light" | "dark" };

export function CellView({ cell, n, run, sealed, look, onRun, onStop }: { cell: Cell; n: number | string; run?: Run; sealed: boolean; look: CodeLook; onRun: () => void; onStop: () => void }) {
  const busy = run?.state === "running" || run?.state === "queued";
  return (
    <div className={`cell${busy ? " run" : ""}`}>
      <div className="chd">
        <span className="tag">{cell.lang}</span><span>[{n}]</span>
        {run?.state === "running" && <span className="runs"><Spinner size={12} /> running</span>}
        {run?.state === "queued" && <span>queued</span>}
        {run?.state === "skipped" && <span title="Run all stopped at a cell before this one">skipped</span>}
        {run?.ms !== undefined && !busy && <span title={run.ran}>· {run.ms < 1000 ? `${run.ms} ms` : `${(run.ms / 1000).toFixed(1)} s`} · {run.ran ? new Date(run.ran).toTimeString().slice(0, 5) : ""}</span>}
        <span className="row-end">
          {busy ? <Key size="sm" icon="debug-stop" onClick={onStop} title="Stop (restarts the session if it doesn't stop)">Stop</Key>
            : <Key size="sm" kind="quiet" icon="play" onClick={onRun} disabled={sealed} title={sealed ? "A sealed note's cells keep their outputs" : "Run in the hub's session"}>Run</Key>}
        </span>
      </div>
      <div className="code"><Editor value={cell.code} language={cell.lang === "julia" ? julia : python} settings={look.settings} appTheme={look.appTheme} readOnly ariaLabel={`Cell ${n}, ${cell.lang}`} /></div>
      {run && run.outputs.length > 0 && <div className={`out${busy ? " prev" : ""}`}>{run.outputs.map((o, i) => <Out key={i} o={o} />)}</div>}
      {run?.runtime && !busy && <div className="ofoot">{run.runtime.name} {run.runtime.version} · {run.runtime.backend}{run.state === "failed" ? " · failed" : ""}</div>}
    </div>
  );
}

/** The body split into Markdown and cells, in order. */
function segments(body: string, cells: Cell[]) {
  const lines = body.split("\n"), out: ({ md: string } | { cell: Cell; n: number })[] = [];
  let at = 0;
  cells.forEach((c, i) => {
    out.push({ md: lines.slice(at, c.line).join("\n") });
    out.push({ cell: c, n: i + 1 });
    let j = c.line + 1;
    while (j < lines.length && !/^(`{3,}|~{3,})\s*$/.test(lines[j])) j++;   // the closing fence (server/note.ts)
    at = j + 1;
  });
  out.push({ md: lines.slice(at).join("\n") });
  return out;
}

export function ReadView({ note, runs, resolve, look, onLink, onRun, onStop, media }: {
  note: NoteData; runs: Record<string, Run>; resolve: Resolve; look: CodeLook; onLink: (target: string, missing: boolean) => void; onRun: (c: Cell) => void; onStop: (c: Cell) => void;
  /** A picture, a video or a sound the Markdown embeds (markdown.ts leaves a slot for it). */
  media: (path: string, alt: string) => ReactNode;
}) {
  const doc = useRef<HTMLElement>(null), [slots, setSlots] = useState<HTMLElement[]>([]);
  // the slots of the HTML just rendered: a new body makes new ones
  useLayoutEffect(() => {
    const found = [...(doc.current?.querySelectorAll<HTMLElement>(".media-slot") ?? [])];
    setSlots((s) => (s.length === found.length && s.every((x, i) => x === found[i]) ? s : found));
  });
  const md = useMemo(() => renderer(resolve, note.path), [resolve, note.path]);
  const parts = useMemo(() => segments(note.body, note.cells), [note.body, note.cells]);
  // KaTeX comes with the first note that has math (the kit loads it then): the text waits for it rather than
  // show the TeX as written for a moment
  const [math, setMath] = useState(mathLoaded), waiting = !math && note.body.includes("$");
  useEffect(() => {
    if (!waiting) return;
    let live = true;
    loadMath().then(() => live && setMath(true), () => live && setMath(true));   // failed to load: the TeX as written
    return () => { live = false; };
  }, [waiting]);
  const click = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-wl]");
    if (a) { e.preventDefault(); onLink(a.dataset.wl!, a.classList.contains("miss")); }
  };
  return (
    <article ref={doc} className="doc" onClick={click}>
      <Properties props={note.props} intact={note.intact} />
      {parts.map((p, i) => "md" in p
        ? <div key={i} dangerouslySetInnerHTML={{ __html: waiting ? "" : md(p.md) }} />
        : <CellView key={`${i}-${p.cell.hash}`} cell={p.cell} n={p.n} run={runs[p.cell.hash] ?? note.outputs[p.cell.hash]} sealed={note.sealed} look={look} onRun={() => onRun(p.cell)} onStop={() => onStop(p.cell)} />)}
      {slots.map((el, i) => createPortal(media(el.dataset.path!, el.dataset.alt ?? ""), el, `m${i}`))}
    </article>
  );
}
