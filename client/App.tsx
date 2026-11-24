// Malachite's page (agent-docs/rebrand/apps/malachite): the bar, the rail (Notes, Views, Trace, Log; the
// foot Search, Settings, Help), and on Notes the hub tree, the note and its Links as cards that hide to
// slim bars. Everything it shows comes from the app server; files are the record.
import {
  AppMark, Dialog, Key, Panel, Rail, Search, Segmented, ThemePicker, Toasts, chordMatches, readStored, typing, useTheme, useToasts, writeStored,
  type SearchItem, type Theme,
} from "@paperboatlab/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, listen, type Cell, type Entry, type Item, type Links, type LogEvent, type NoteData, type Run } from "./api.ts";
import { Editor } from "./Editor.tsx";
import { FileIcon, IMAGE, OWNER, TEXT, typeOf } from "./files.tsx";
import { ReadView } from "./Note.tsx";
import { Ev, LinksCard, RuntimesKey } from "./Side.tsx";
import { Tree, type FileActions } from "./Tree.tsx";

type Page = "notes" | "views" | "trace" | "log";
type Ask = { title: string; label?: string; value?: string; danger?: boolean; ok: string; run: (v: string) => void };
const isTheme = (v: unknown): v is Theme => v === "light" || v === "dark" || v === "system";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export function App() {
  const [theme, setTheme] = useState<Theme>(() => readStored("paperboat.theme", isTheme) ?? "system");
  useTheme(theme);
  const [hub, setHub] = useState<{ name: string; root: string } | null>(null);
  const [tree, setTree] = useState<Entry[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [page, setPage] = useState<Page>("notes");
  const [wide, setWide] = useState(() => readStored("malachite.rail.wide", isBool) ?? false);
  const [hideL, setHideL] = useState(false), [hideR, setHideR] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set(readStored("malachite.tree.open", isList) ?? []));
  const [tabs, setTabs] = useState<string[]>(() => readStored("malachite.tabs", isList) ?? []);
  const [current, setCurrent] = useState<string | null>(() => readStored("malachite.tabs", isList)?.[0] ?? null);
  const [note, setNote] = useState<NoteData | null>(null);
  const [plain, setPlain] = useState<string | null>(null);   // a text file that isn't a note
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [draft, setDraft] = useState<string | null>(null);
  const [links, setLinks] = useState<Links | null>(null);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [peekVersion, setPeekVersion] = useState(0);
  const [log, setLog] = useState<LogEvent[]>([]);
  const [search, setSearch] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const { toasts, show, dismiss } = useToasts();
  const fail = useCallback((e: unknown) => show({ title: "Couldn't do that", detail: String((e as Error).message ?? e), state: "failed" }), [show]);
  const currentRef = useRef(current);
  currentRef.current = current;

  useEffect(() => writeStored("paperboat.theme", theme), [theme]);
  useEffect(() => writeStored("malachite.rail.wide", wide), [wide]);
  useEffect(() => writeStored("malachite.tree.open", [...expanded]), [expanded]);
  useEffect(() => writeStored("malachite.tabs", current ? [current, ...tabs.filter((t) => t !== current)] : tabs), [tabs, current]);

  const reload = useCallback(() => { api.tree().then(setTree, fail); api.index().then(setItems, fail); }, [fail]);
  useEffect(() => { api.hub().then((v) => { setHub(v); document.title = `${v.name} · Malachite`; }, fail); reload(); }, [reload, fail]);

  const load = useCallback((p: string | null) => {
    if (!p) { setNote(null); setPlain(null); setLinks(null); return; }
    const t = typeOf(p);
    if (t === "md") {
      api.note(p).then((n) => { if (currentRef.current === p) { setNote(n); setPlain(null); setDraft(null); } }, fail);
      api.links(p).then((l) => currentRef.current === p && setLinks(l), () => setLinks(null));
    } else {
      setNote(null);
      setLinks(null);
      if (TEXT.has(t)) api.text(p).then((s) => currentRef.current === p && setPlain(s), fail); else setPlain(null);
    }
  }, [fail]);
  useEffect(() => { setRuns({}); load(current); }, [current, load]);

  // live: files (anyone's changes), cells, sessions and the log
  useEffect(() => listen((e) => {
    if (e.type === "files") {
      reload();
      const c = currentRef.current;
      if (c && (e.changed as string[]).some((f) => f === c)) setDraft((d) => { if (d === null) load(c); return d; });
    } else if (e.type === "cell") {
      const r = e.run as Run;
      if (e.path === currentRef.current) setRuns((m) => ({ ...m, [r.hash]: r }));
      setRunning((m) => ({ ...m, [r.lang]: r.state === "running" || r.state === "queued" }));
      setPeekVersion((v) => v + 1);
    } else if (e.type === "session") {
      if (e.state === "stopped") setRunning((m) => ({ ...m, [e.lang]: false }));
      setPeekVersion((v) => v + 1);
    } else if (e.type === "log") {
      setLog((l) => [e.event, ...l].slice(0, 300));
      const c = currentRef.current;
      if (c && typeOf(c) === "md") api.links(c).then((l) => currentRef.current === c && setLinks(l), () => {});
    }
  }), [reload, load]);
  useEffect(() => { if (page === "log") api.log().then(setLog, fail); }, [page, fail]);
  // a deep link opens a file: /?open=<path in the hub>&mode=edit (the Launcher and other apps use it)
  useEffect(() => {
    const u = new URLSearchParams(location.search), p = u.get("open");
    if (p) open(p, false, u.get("mode") === "edit" ? "edit" : "read");
    // once, at start
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Opens a file in a tab (to the side: behind the current one); a note opens in Read unless asked. */
  const open = useCallback((p: string, side = false, view: "read" | "edit" = "read") => {
    setPage("notes");
    if (!side) setMode(view);
    setTabs((t) => (t.includes(p) ? t : side ? [...t, p] : [p, ...t].slice(0, 12)));
    if (!side) setCurrent(p);
    setExpanded((s) => { const n = new Set(s); for (let d = dirOf(p); d; d = dirOf(d)) n.add(d); return n; });
  }, []);
  const close = (p: string) => {
    const rest = tabs.filter((t) => t !== p);
    setTabs(rest);
    if (current === p) setCurrent(rest[0] ?? null);
  };

  const resolve = useMemo(() => {
    const byName = new Map<string, string>();
    for (const it of items) { byName.set(it.name.toLowerCase(), it.path); byName.set(it.path.slice(it.path.lastIndexOf("/") + 1).toLowerCase(), it.path); }
    const paths = new Set(items.map((i) => i.path));
    return (l: string) => (paths.has(l) ? l : paths.has(`${l}.md`) ? `${l}.md` : byName.get(l.toLowerCase()) ?? null);
  }, [items]);

  const save = useCallback(async (p: string, text: string) => {
    try { await api.save(p, text); setDraft(null); } catch (e) { fail(e); }
  }, [fail]);
  // save what is typed after a pause; the file is the record
  useEffect(() => {
    if (draft === null || !current) return;
    const t = setTimeout(() => save(current, draft), 700);
    return () => clearTimeout(t);
  }, [draft, current, save]);

  const newNote = useCallback((dir = current ? dirOf(current) : "") => setAsk({
    title: "New note", label: "Title", ok: "Create",
    run: (title) => api.create(dir, title).then((r) => { reload(); open(r.path, false, "edit"); }, fail),
  }), [current, open, reload, fail]);

  const actions: FileActions = {
    open, newNote,
    newFolder: (dir) => setAsk({ title: "New folder", label: "Name", ok: "Create", run: (n) => api.folder(dir ? `${dir}/${n}` : n).then(() => { reload(); setExpanded((s) => new Set(s).add(dir)); }, fail) }),
    rename: (p) => setAsk({
      title: "Rename", label: "Path in the hub", value: p, ok: "Rename",
      run: (to) => to !== p && api.move(p, to).then(() => { reload(); setTabs((t) => t.map((x) => (x === p ? to : x))); if (current === p) setCurrent(to); }, fail),
    }),
    trash: (p) => setAsk({ title: `Move ${p} to the trash?`, danger: true, ok: "Move to trash", run: () => api.trash(p).then(() => { reload(); close(p); show({ title: "Moved to the trash", detail: `${p} · .malachite/trash`, state: "done" }); }, fail) }),
    seal: (p) => setAsk({
      title: `Seal ${p}?`, ok: "Seal", danger: true,
      run: () => api.seal(p).then(() => { load(p); show({ title: "Sealed", detail: `${p}: its body is frozen and hashed; corrections go in a new note`, state: "done" }); }, fail),
    }),
    copy: (text, what) => navigator.clipboard.writeText(text).then(() => show({ title: `${what} copied`, detail: text, state: "done" }), fail),
    reveal: (p) => { api.reveal(p).catch(fail); },
    backlinks: (p) => { open(p); setHideR(false); },
    backlinkCount: (p) => items.filter((it) => it.path !== p && it.links.some((l) => resolve(l) === p)).length,
    sealed: (p) => !!items.find((i) => i.path === p)?.props.sealed,
  };

  const runCell = (c: Cell) => { if (current) api.run(current, c.hash).then((r) => setRuns((m) => ({ ...m, [c.hash]: r })), fail); };
  const stopCell = (c: Cell) => { api.interrupt(c.lang).catch(fail); };
  const onLink = (target: string, missing: boolean) => {
    if (!missing) return open(target);
    setAsk({ title: `Create ${target}?`, label: "Title", value: target, ok: "Create", run: (t) => api.create(current ? dirOf(current) : "", t).then((r) => { reload(); open(r.path); }, fail) });
  };

  // keys: Ctrl K search, Ctrl B / Ctrl Alt B the side cards, Ctrl \ the rail, Alt 1–4 the pages, Ctrl N a note
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (chordMatches({ key: "k", ctrl: true }, e)) { e.preventDefault(); setSearch((s) => !s); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") { e.preventDefault(); (e.altKey ? setHideR : setHideL)((h) => !h); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "\\") { e.preventDefault(); setWide((w) => !w); return; }
      if (typing(e.target)) return;
      if (e.altKey && "1234".includes(e.key)) { e.preventDefault(); setPage((["notes", "views", "trace", "log"] as Page[])[+e.key - 1]); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") { e.preventDefault(); newNote(); }
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [newNote]);

  const searchItems: SearchItem[] = useMemo(() => [
    ...items.filter((i) => i.type === "md").map((i): SearchItem => ({ id: `n:${i.path}`, label: i.title, detail: i.path, group: "Notes", scope: "Notes", icon: "markdown", run: () => open(i.path) })),
    ...items.filter((i) => i.type !== "md").map((i): SearchItem => ({ id: `f:${i.path}`, label: i.path.slice(i.path.lastIndexOf("/") + 1), detail: dirOf(i.path), group: "Files", scope: "Files", icon: "file", run: () => open(i.path) })),
    ...[...new Set(items.flatMap((i) => i.tags))].sort().map((t): SearchItem => ({ id: `t:${t}`, label: `#${t}`, detail: `${items.filter((i) => i.tags.includes(t)).length} notes`, group: "Tags", scope: "Notes", icon: "tag", run: () => setPage("views") })),
    { id: "c:new", label: "New note", shortcut: "Ctrl N", group: "Commands", scope: "Commands", icon: "new-file", run: () => newNote() },
    { id: "c:seal", label: "Seal this note…", group: "Commands", scope: "Commands", icon: "lock", disabled: !note || note.sealed, why: note?.sealed ? "It is sealed" : "Open a note first", run: () => note && actions.seal(note.path) },
    { id: "c:jl", label: "Restart the Julia session", group: "Commands", scope: "Commands", icon: "debug-restart", run: () => { api.restart("julia").catch(fail); } },
    { id: "c:py", label: "Restart the Python session", group: "Commands", scope: "Commands", icon: "debug-restart", run: () => { api.restart("python").catch(fail); } },
    { id: "c:edit", label: mode === "edit" ? "Read this note" : "Edit this note", group: "Commands", scope: "Commands", icon: "command", disabled: !note, why: "Open a note first", run: () => setMode((m) => (m === "edit" ? "read" : "edit")) },
    ...(["notes", "views", "trace", "log"] as Page[]).map((p, i): SearchItem => ({ id: `g:${p}`, label: `Go to ${p[0].toUpperCase()}${p.slice(1)}`, shortcut: `Alt ${i + 1}`, group: "Commands", scope: "Commands", icon: "go", run: () => setPage(p) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [items, note, mode, open, newNote, fail]);

  const t = current ? typeOf(current) : "";
  const nRunning = Object.values(running).filter(Boolean).length;
  const mdCount = items.filter((i) => i.type === "md").length;

  return (
    <div className={`win${hideL ? " hide-l" : ""}${hideR ? " hide-r" : ""}`}>
      <header className="bar">
        <AppMark app="malachite" size={26} idle label="Malachite" />
        <span className="wm">Malachite</span>
        <span className="well hub" title={hub?.root}>{FileIcon({ path: "", dir: true })}{hub?.name ?? "…"}</span>
        <span className="bend">
          {page === "notes" && <Key kind="primary" icon="new-file" onClick={() => newNote()}>New note</Key>}
          <RuntimesKey running={nRunning} version={peekVersion} />
          {page === "notes" && <span className="lgroup">
            <Key kind="quiet" round icon="layout-left" label={`${hideL ? "Show" : "Hide"} the files (Ctrl B)`} className={`lk${hideL ? " off" : ""}`} onClick={() => setHideL((h) => !h)} />
            <Key kind="quiet" round icon="layout-right" label={`${hideR ? "Show" : "Hide"} the links (Ctrl Alt B)`} className={`lk${hideR ? " off" : ""}`} onClick={() => setHideR((h) => !h)} />
          </span>}
          <span className="lsep" />
          <ThemePicker theme={theme} onChange={setTheme} />
        </span>
      </header>

      <Rail label="Malachite pages" wide={wide} onWide={setWide} page={page} onPage={(p) => setPage(p as Page)}
        pages={[{ id: "notes", label: "Notes", icon: "a-notes", keys: "Alt+1", count: nRunning ? "live" : mdCount }, { id: "views", label: "Views", icon: "a-views", keys: "Alt+2" },
          { id: "trace", label: "Trace", icon: "a-trace", keys: "Alt+3" }, { id: "log", label: "Log", icon: "a-log", keys: "Alt+4" }]}
        foot={[{ id: "search", label: "Search", icon: "search", keys: "Ctrl+K" }, { id: "settings", label: "Settings", icon: "a-settings" }, { id: "help", label: "Help", icon: "question", keys: "F1" }]}
        onFoot={(id) => { if (id === "search") setSearch(true); else show({ title: id === "settings" ? "Settings" : "Help", detail: "Not in v0.1: the hub's settings are hub.toml; the guide is the README.", state: "done" }); }} />

      <main className="pages">
        {page === "notes" && (
          <div className="notes">
            <Panel name={hub?.name ?? "Hub"} count={`${items.length}`} side="left" hidden={hideL} onHidden={setHideL} icon="a-notes" width={262}
              head={<span className="tools"><Key size="sm" kind="quiet" round icon="new-file" label="New note (Ctrl N)" onClick={() => newNote("")} /><Key size="sm" kind="quiet" round icon="new-folder" label="New folder" onClick={() => actions.newFolder("")} /></span>}>
              <Tree entries={tree} current={current} open={expanded} actions={actions}
                onToggle={(p) => setExpanded((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; })} />
            </Panel>

            <section className="panel note" aria-label="Note">
              <div className="ntabs">
                <div className="tabs2" role="tablist">
                  {tabs.map((p) => (
                    <span key={p} role="tab" aria-selected={p === current} className={p === current ? "on" : ""} onClick={() => open(p)} onAuxClick={(e) => e.button === 1 && close(p)}>
                      <FileIcon path={p} size={14} />{p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/, "")}
                      <button type="button" className="tx" aria-label={`Close ${p}`} onClick={(e) => { e.stopPropagation(); close(p); }}>×</button>
                    </span>
                  ))}
                </div>
              </div>
              {current && (
                <div className="crumb">
                  <span>{hub?.name} / {current.split("/").slice(0, -1).map((d) => `${d} / `).join("")}<b>{current.slice(current.lastIndexOf("/") + 1)}</b></span>
                  <span className="bend">
                    {note && <span>{draft !== null ? "saving…" : note.sealed ? "sealed" : "saved"}</span>}
                    {note && !note.sealed && <Key size="sm" icon="lock" onClick={() => actions.seal(note.path)} title="Seal: freeze the body and record its hash">Seal…</Key>}
                  </span>
                </div>
              )}
              <div className="body">
                {!current && <div className="empty"><AppMark app="malachite" size={72} idle label="" /><p>Open a note from the hub, or make one.</p><Key kind="primary" icon="new-file" onClick={() => newNote("")}>New note</Key></div>}
                {note && mode === "read" && <ReadView note={note} runs={runs} resolve={resolve} onLink={onLink} onRun={runCell} onStop={stopCell} />}
                {note && mode === "edit" && <Editor key={`${note.path}:${note.sealed}`} text={draft ?? note.text} readOnly={note.sealed} onChange={setDraft} onSave={() => draft !== null && current && save(current, draft)} />}
                {current && t !== "md" && <FileView path={current} text={plain} />}
              </div>
              {note && <div className="efoot"><span>markdown · {note.body.split(/\s+/).filter(Boolean).length} words · {note.cells.length} cells</span>
                <Segmented label="View" value={mode} onChange={setMode} options={[{ value: "read", label: "Read" }, { value: "edit", label: "Edit" }]} /><span>{links?.backlinks.length ?? 0} backlinks · {links?.links.length ?? 0} links</span></div>}
            </section>

            <Panel name="Links" side="right" hidden={hideR} onHidden={setHideR} icon="references" width={300}>
              <LinksCard links={links} onOpen={open} onCreate={(n) => onLink(n, true)} />
            </Panel>
          </div>
        )}
        {page === "log" && (
          <Panel name="Activity log" count={`${log.length} events · log/*.jsonl`}>
            <div className="lev big">{log.map((e, i) => <Ev key={i} e={e} path />)}</div>
          </Panel>
        )}
        {(page === "views" || page === "trace") && (
          <Panel name={page === "views" ? "Views" : "Trace"}>
            <div className="empty"><p>{page === "views" ? "Board, list and timeline of the hub's notes, by their properties" : "What a note, run or model came from and what came of it, on React Flow"}: in v0.2.</p></div>
          </Panel>
        )}
      </main>

      {search && <Search items={searchItems} scopes={["All", "Notes", "Files", "Commands"]} placeholder={`Search ${hub?.name ?? "the hub"} or run a command`} onClose={() => setSearch(false)} />}
      {ask && <AskDialog ask={ask} onClose={() => setAsk(null)} />}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function FileView({ path, text }: { path: string; text: string | null }) {
  const t = typeOf(path), owner = OWNER[t];
  return (
    <div className="fileview">
      <div className="fcard"><FileIcon path={path} size={20} /><b>{path.slice(path.lastIndexOf("/") + 1)}</b>
        <small>{owner ? `${owner} draws this once it is installed; Malachite only indexes its name and type.` : IMAGE.has(t) ? "an image in the hub" : "a file in the hub"}</small></div>
      {IMAGE.has(t) && <img className="fimg" src={api.raw(path)} alt={path} />}
      {text !== null && <pre className="ftext">{text}</pre>}
    </div>
  );
}

function AskDialog({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const [v, setV] = useState(ask.value ?? "");
  const go = () => { if (!ask.label || v.trim()) { ask.run(v.trim()); onClose(); } };
  return (
    <Dialog title={ask.title} onClose={onClose} actions={<><Key kind={ask.danger ? "danger" : "primary"} onClick={go}>{ask.ok}</Key><Key onClick={onClose}>Cancel</Key></>}>
      {ask.label
        ? <label className="well ask"><input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); go(); } }} aria-label={ask.label} /><em>{ask.label}</em></label>
        : <p>{ask.danger && ask.ok === "Seal" ? "Its body is frozen and hashed; afterwards it only takes annotations, and corrections go in a new note." : "It goes to .malachite/trash in the hub, so it can come back."}</p>}
    </Dialog>
  );
}
