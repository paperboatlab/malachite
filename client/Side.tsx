// The Links card (backlinks with their line, the note's links, its history from the log) and the
// runtimes key with its peek (REBRAND "Runtimes key"): one key, never a row of pills.
import { Icon, Key, Spinner, useDismiss } from "@paperboatlab/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type LogEvent, type Lang, type Links, type Peek } from "./api.ts";
import { FileGlyph } from "./files.tsx";

/** A backlink's line, its wikilinks shown as their text, the ones naming this note highlighted. */
function Context({ text, self }: { text: string; self: string }) {
  const me = self.slice(self.lastIndexOf("/") + 1).replace(/\.md$/i, "").toLowerCase();
  return <p>{text.split(/(\[\[[^\]]+\]\])/).map((part, i) => {
    const m = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]$/.exec(part);
    if (!m) return part;
    const target = m[1].slice(m[1].lastIndexOf("/") + 1).replace(/\.md$/i, "").trim().toLowerCase();
    return target === me ? <mark key={i} className="me">{m[2] ?? m[1]}</mark> : <b key={i}>{m[2] ?? m[1]}</b>;
  })}</p>;
}

export function LinksCard({ links, self, graph, onOpen, onCreate }: { links: Links | null; self: string; graph?: ReactNode; onOpen: (p: string) => void; onCreate: (name: string) => void }) {
  if (!links) return <div className="sh muted">No note open.</div>;
  return (
    <>
      {graph && <><div className="sh"><b>Local graph</b></div><div className="lgraph">{graph}</div></>}
      <div className="sh"><b>Backlinks</b><code>{links.backlinks.length}</code></div>
      {links.backlinks.length === 0 && <p className="none">Nothing links here yet.</p>}
      {links.backlinks.map((b) => (
        <button key={b.path} type="button" className="bl" onClick={() => onOpen(b.path)}>
          <div><FileGlyph path={b.path} />{b.title}</div>
          {b.context && <Context text={b.context} self={self} />}
        </button>
      ))}
      <div className="sh hr"><b>Links</b><code>{links.links.length}</code></div>
      <div className="ol">
        {links.links.map((l) => l.path
          ? <button key={l.link} type="button" onClick={() => onOpen(l.path!)}><FileGlyph path={l.path} />{l.link}</button>
          : <button key={l.link} type="button" className="miss" onClick={() => onCreate(l.link)} title="Not written yet: click to create"><Icon name="file" size={16} />{l.link}<small>not yet</small></button>)}
      </div>
      <div className="sh hr"><b>History</b><code>log/</code></div>
      <div className="lev">{links.history.map((e, i) => <Ev key={i} e={e} />)}</div>
    </>
  );
}

export function Ev({ e, path }: { e: LogEvent; path?: boolean }) {
  if ("damaged" in e) return <><time>!</time><span className="bad">damaged line · {e.damaged}</span></>;
  const t = new Date(e.time);
  return (
    <>
      <time title={e.time}>{t.toDateString() === new Date().toDateString() ? t.toTimeString().slice(0, 5) : t.toISOString().slice(5, 10)}</time>
      <span>{e.action}{path && e.target ? <> · {e.target}</> : null} <em>{e.actor}</em></span>
    </>
  );
}

const mb = (b?: number) => (b && b > 0 ? b > 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${Math.round(b / (1 << 20))} MB` : "");
const dur = (s?: number) => (s === undefined ? "" : s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

export function RuntimesKey({ running, version }: { running: number; version: number }) {
  const [open, setOpen] = useState(false);
  const [peek, setPeek] = useState<Peek | null>(null);
  const [error, setError] = useState("");
  const pop = useRef<HTMLDivElement>(null), key = useRef<HTMLButtonElement>(null);
  useDismiss(pop, () => setOpen(false), { enabled: open, triggerRef: key });
  useEffect(() => {
    if (!open) return;
    api.runtimes().then((p) => { setPeek(p); setError(""); }, (e) => setError(e.message));
  }, [open, version]);
  const act = (f: () => Promise<unknown>) => f().catch((e) => setError(e.message)).then(() => api.runtimes().then(setPeek, () => {}));
  const started = new Set(peek?.sessions.map((s) => s.runtime));
  return (
    <span className="rtw">
      <button ref={key} type="button" className={`key ico rtk${running ? " live" : ""}`} aria-expanded={open} title={`Runtimes${running ? `: ${running} running` : ""}`} onClick={() => setOpen((o) => !o)}>
        <Icon name="a-runtimes" />{running > 0 && <b className="badge">{running}</b>}
      </button>
      {open && (
        <div ref={pop} className="popover rtpop" role="dialog" aria-label="Runtimes">
          <div className="poph"><b>Runtimes</b><span>this hub · paperboat-runtime/0</span></div>
          {error && <p className="rterr">{error}</p>}
          {!peek && !error && <p className="rterr"><Spinner size={12} /> asking paperboatd…</p>}
          {peek?.sessions.map((s) => {
            const lang = s.runtime as Lang, busy = s.running.length > 0;
            return (
              <div key={s.id} className={`rt${busy ? " run" : ""}`}>
                <span className="rlg">{s.runtime === "julia" ? "jl" : "py"}</span>
                <div><b>{s.runtime}</b><small>session · {s.backend} · up {dur(s.uptime_s)}{s.stats ? ` · ${mb(s.stats.memory_bytes)}` : ""}</small>
                  {busy ? <p className="now"><Spinner size={12} />running a cell in {s.running[0].note}</p> : <p>idle {dur(s.idle_s)}</p>}</div>
                <div className="acts">
                  {busy && <Key size="sm" kind="quiet" round icon="debug-pause" label="Interrupt the running cell" onClick={() => act(() => api.interrupt(lang))} />}
                  <Key size="sm" kind="quiet" round icon="debug-restart" label="Restart the session (its variables are lost)" onClick={() => act(() => api.restart(lang))} />
                </div>
              </div>
            );
          })}
          {peek?.runtimes.filter((r) => !started.has(r.name)).map((r) => (
            <div key={r.name} className="rt off"><span className="rlg">{r.name === "julia" ? "jl" : r.name === "python" ? "py" : r.name.slice(0, 2)}</span>
              <div><b>{r.name} {r.version}</b><small>not started · starts with the first cell</small></div><div /></div>
          ))}
          <div className="pfoot"><span>Each cell names its runtime by its language.</span></div>
        </div>
      )}
    </span>
  );
}
