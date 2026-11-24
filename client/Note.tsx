// A note: its properties (the front matter, time and author set by the app), then the body. Read shows
// it rendered with its cells runnable in place; Edit is the Markdown itself.
import { Icon, Key, Spinner, type IconName } from "@paperboatlab/ui";
import { useMemo } from "react";
import type { Cell, NoteData, Output, Props, Run } from "./api.ts";
import { renderer, type Resolve } from "./markdown.ts";

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

function Out({ o }: { o: Output }) {
  if (o.type === "stream") return <pre className={`stream ${o.name}`}>{o.text}</pre>;
  if (o.type === "error") return <pre className="err"><b>{o.error.type ? `${o.error.type}: ` : ""}{o.error.message}</b>{o.error.traceback ? `\n${o.error.traceback}` : ""}</pre>;
  const d = o.data;
  // a picture shows itself; HTML from a runtime is not trusted in the page, its text stands in
  if (d["image/png"]) return <div className="screen"><img alt={d["text/plain"] ?? "image"} src={`data:image/png;base64,${d["image/png"]}`} /></div>;
  if (d["image/svg+xml"]) return <div className="screen light"><img alt={d["text/plain"] ?? "image"} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(d["image/svg+xml"])}`} /></div>;
  return <pre className="val">{d["text/plain"] ?? ""}</pre>;
}

function CellView({ cell, n, run, sealed, onRun, onStop }: { cell: Cell; n: number; run?: Run; sealed: boolean; onRun: () => void; onStop: () => void }) {
  const busy = run?.state === "running" || run?.state === "queued";
  return (
    <div className={`cell${busy ? " run" : ""}`}>
      <div className="chd">
        <span className="tag">{cell.lang}</span><span>[{n}]</span>
        {run?.state === "running" && <span className="runs"><Spinner size={12} /> running</span>}
        {run?.state === "queued" && <span>queued</span>}
        {run?.ms !== undefined && !busy && <span title={run.ran}>· {run.ms < 1000 ? `${run.ms} ms` : `${(run.ms / 1000).toFixed(1)} s`} · {run.ran ? new Date(run.ran).toTimeString().slice(0, 5) : ""}</span>}
        <span className="bend">
          {busy ? <Key size="sm" icon="debug-stop" onClick={onStop} title="Stop (restarts the session if it doesn't stop)">Stop</Key>
            : <Key size="sm" kind="quiet" icon="play" onClick={onRun} disabled={sealed} title={sealed ? "A sealed note's cells keep their outputs" : "Run in the hub's session"}>Run</Key>}
        </span>
      </div>
      <pre className="code">{cell.code}</pre>
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

export function ReadView({ note, runs, resolve, onLink, onRun, onStop }: {
  note: NoteData; runs: Record<string, Run>; resolve: Resolve; onLink: (target: string, missing: boolean) => void; onRun: (c: Cell) => void; onStop: (c: Cell) => void;
}) {
  const md = useMemo(() => renderer(resolve, note.path), [resolve, note.path]);
  const parts = useMemo(() => segments(note.body, note.cells), [note.body, note.cells]);
  const click = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-wl]");
    if (a) { e.preventDefault(); onLink(a.dataset.wl!, a.classList.contains("miss")); }
  };
  return (
    <article className="doc" onClick={click}>
      <Properties props={note.props} intact={note.intact} />
      {parts.map((p, i) => "md" in p
        ? <div key={i} dangerouslySetInnerHTML={{ __html: md(p.md) }} />
        : <CellView key={`${i}-${p.cell.hash}`} cell={p.cell} n={p.n} run={runs[p.cell.hash] ?? note.outputs[p.cell.hash]} sealed={note.sealed} onRun={() => onRun(p.cell)} onStop={() => onStop(p.cell)} />)}
    </article>
  );
}
