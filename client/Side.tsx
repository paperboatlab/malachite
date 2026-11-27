// The Links card (backlinks with their line, the note's links, its history from the log) and the
// runtimes key (the kit's RuntimesKey, fed from paperboatd through the server).
import { Icon, Key, RuntimesKey, type Runtime } from "@paperboatlab/ui";
import { useEffect, useState, type ReactNode } from "react";
import { api, type LogEvent, type Links, type Peek, type Version } from "./api.ts";
import { FileGlyph } from "./files.tsx";

/** A backlink's line, its wikilinks shown as their text, the ones naming this note highlighted. */
function Context({ text, self }: { text: string; self: string }) {
  const me = self.slice(self.lastIndexOf("/") + 1).replace(/\.md$/i, "").toLowerCase();
  return <p>{text.split(/(\[\[[^\]]+\]\])/).map((part, i) => {
    const m = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]$/.exec(part);
    if (!m) return part.replace(/(\*\*|__|\*|`)(.+?)\1/g, "$2");   // the line as read, not its Markdown marks
    const target = m[1].slice(m[1].lastIndexOf("/") + 1).replace(/\.md$/i, "").trim().toLowerCase();
    return target === me ? <mark key={i} className="me">{m[2] ?? m[1]}</mark> : <b key={i}>{m[2] ?? m[1]}</b>;
  })}</p>;
}

export function LinksCard({ links, self, graph, onOpen, onCreate, onRestore }: { links: Links | null; self: string; graph?: ReactNode; onOpen: (p: string) => void; onCreate: (name: string) => void; onRestore: (v: Version) => void }) {
  if (!links) return <p className="empty-state">No note open.</p>;
  return (
    <>
      {graph && <><div className="sh"><b>Local graph</b></div><div className="lgraph">{graph}</div></>}
      <div className="sh"><b>Backlinks</b><code>{links.backlinks.length}</code></div>
      {links.backlinks.length === 0 && <p className="empty-note">Nothing links here yet.</p>}
      {links.backlinks.map((b) => (
        <button key={b.path} type="button" className="bl" onClick={() => onOpen(b.path)}>
          <div><FileGlyph path={b.path} />{b.title}</div>
          {b.context && <Context text={b.context} self={self} />}
        </button>
      ))}
      <div className="sh hr"><b>Links</b><code>{links.links.length}</code></div>
      {links.links.length === 0 && <p className="empty-note">This note links to nothing yet.</p>}
      <div className="ol">
        {links.links.map((l) => l.path
          ? <button key={l.link} type="button" onClick={() => onOpen(l.path!)}><FileGlyph path={l.path} />{l.link}</button>
          : <button key={l.link} type="button" className="miss" onClick={() => onCreate(l.link)} title="Not written yet: click to create"><Icon name="file" size={16} />{l.link}<small>not yet</small></button>)}
      </div>
      <div className="sh hr"><b>History</b><code>log/</code></div>
      {links.history.length === 0 && <p className="empty-note">Nothing logged for this note yet.</p>}
      <div className="lev">{links.history.map((e, i) => <Ev key={i} e={e} />)}</div>
      <Versions path={self} changed={links} onRestore={onRestore} />
    </>
  );
}

/** The note's versions (the hub's history, Git underneath, never named): when, who, what, Restore. */
function Versions({ path, changed, onRestore }: { path: string; changed: unknown; onRestore: (v: Version) => void }) {
  const [vs, setVs] = useState<{ ok: boolean; example?: boolean; versions: Version[] } | null>(null);
  useEffect(() => { let live = true; api.versions(path).then((v) => live && setVs(v), () => live && setVs(null)); return () => { live = false; }; }, [path, changed]);
  if (!vs) return null;
  return (
    <>
      <div className="sh hr"><b>Versions</b><code>{vs.versions.length || ""}</code></div>
      {!vs.ok && <p className="empty-note">{vs.example ? "An example keeps no versions: a copy of it does." : "History needs Git on this computer."}</p>}
      {vs.ok && vs.versions.length === 0 && <p className="empty-note">Saved changes become versions here.</p>}
      <div className="vers">
        {vs.versions.slice(0, 30).map((v, i) => (
          <div key={v.id} className="ver">
            <time title={v.time}>{new Date(v.time).toDateString() === new Date().toDateString() ? v.time.slice(11, 16) : v.time.slice(5, 10)}</time>
            <span>{v.what} <em>{v.author}</em></span>
            {i > 0 && <Key size="sm" kind="quiet" onClick={() => onRestore(v)}>Restore</Key>}
          </div>
        ))}
      </div>
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

/** The hub's runtimes on the kit's key: asked from paperboatd when the peek opens (and on news while open). */
export function Runtimes({ running, version }: { running: number; version: number }) {
  const [open, setOpen] = useState(false);
  const [peek, setPeek] = useState<Peek | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    api.runtimes().then((p) => { setPeek(p); setError(""); }, (e) => setError(e.message));
  }, [open, version]);
  const act = (f: () => Promise<unknown>) => f().catch((e) => setError(e.message)).then(() => api.runtimes().then(setPeek, () => {}));
  const started = new Set<string>(peek?.sessions.map((s) => s.lang));
  const rows: Runtime[] | undefined = peek ? [
    ...peek.sessions.map((s): Runtime => ({
      id: s.id, name: s.runtime, lang: s.lang, state: s.running.length ? "busy" : "idle", via: s.backend, up: s.uptime_s, idle: s.idle_s, memory: s.stats?.memory_bytes,
      now: s.running[0] && `running a cell in ${s.running[0].title ?? s.running[0].note}`,
      onInterrupt: () => act(() => api.interrupt(s.lang)), onRestart: () => act(() => api.restart(s.lang)),
    })),
    ...peek.runtimes.filter((r) => !started.has(r.name)).map((r): Runtime => ({ id: r.name, name: `${r.name} ${r.version}`, lang: r.name, state: "off" })),
  ] : undefined;
  return <RuntimesKey scope="this hub" live={running > 0} count={running} runtimes={rows} error={error || undefined} onOpenChange={setOpen}
    footer={<span>Each cell names its runtime by its language.</span>} />;
}
