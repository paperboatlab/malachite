// Malachite's page (agent-docs/rebrand/apps/malachite): the bar (the menu bar, the hub's workspace well, the
// keys, the window keys), the rail (Notes, Views, Graph, Log; the foot Search, Settings, Help), and on Notes the
// hub's files, the note and its Links as cards that hide to slim bars. With no hub open, the Start page (the
// one file workflow, agent-docs/rebrand/apps/files: Malachite works in hubs only). The parts are the kit's
// (@paperboatlab/ui): the menus and the command registry, the workspace parts, the file tree, the editor and
// its languages, the plot, the canvas layout; Malachite brings the hub, its notes and cells. Files are the record.
import {
  About, AppMark, Dialog, Key, Menu, MenuBar, Notifications, Panel, PanelsKey, Rail, Search, Segmented, SettingRow, Settings, SettingsSection, ShortcutList, THEMES, ThemeSetting, Toasts, WindowKeys, isEnabled, readStored, useShortcuts, useTheme, useToasts, writeStored,
  type Command, type CommandMenu, type Credit, type MenuEntry, type SearchItem, type Theme,
} from "@paperboatlab/ui";
import { Editor, EditorSettingsPane, EditorTabs, afterClose, languageFor, livePreview, markdown, orderTabs, tabMenu, useEditorSettings, type Session } from "@paperboatlab/ui/editor";
import { EditorView } from "@codemirror/view";
import { FileTree, type FileEntry } from "@paperboatlab/ui/files";
import { ConnectHub, HubSettings, OpenFile, SaveFile, type Hub as KitHub } from "@paperboatlab/ui/hub";
import { NotAHub, Start, TypedPath, Unsaved, WorkspaceWell, fileMenu as fileCommands, recentFor, recentMenu, shell, type RecentEntry } from "@paperboatlab/ui/workspace";
import { redo, undo } from "@codemirror/commands";
import { Plot2D, type PlotSeries } from "@paperboatlab/ui/plot";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { join, patch, split } from "../server/frontmatter.ts";
import { api, listen, type Cell, type Entered, type HubConf, type KnownHub, type Place, type Workspace, type Entry, type Item, type Lang, type Links, type LogEvent, type NoteData, type Props, type Run } from "./api.ts";
import { fileMenu, type FileActions } from "./fileMenu.ts";
import { FileGlyph, OWNER, TEXT, mediaOf, typeOf } from "./files.tsx";
import { MediaEmbed } from "./Media.tsx";
import { CellView, PropsEditor, ReadView, type CodeLook } from "./Note.tsx";
import { valuesIn } from "./views.ts";
import { Ev, LinksCard, Runtimes } from "./Side.tsx";
import { HubGraph, hubLinks } from "./Graph.tsx";
import { ViewsPage } from "./Views.tsx";
import { TrashList } from "./Trash.tsx";

declare const __VERSION__: string, __COMMIT__: string;   // scripts/build.ts
/** What Malachite ships beyond the kit (the kit names its own: React, CodeMirror, the canvas…). */
const CREDITS: Credit[] = [["marked", "Markdown", "MIT", "https://marked.js.org"]];

type Page = "notes" | "views" | "graph" | "log";
type Mode = "read" | "live" | "edit";

/** A cell drawn into Live: Read's cell, known by its hash as the server knows it (the code may be unsaved). */
function LiveCell({ lang, code, note, runs, look, onRun, onStop }: {
  lang: string; code: string; note: NoteData; runs: Record<string, Run>; look: CodeLook; onRun: (c: Cell) => void; onStop: (c: Cell) => void;
}) {
  const L: Lang = lang.startsWith("j") ? "julia" : "python";
  const [hash, setHash] = useState(() => note.cells.find((c) => c.lang === L && c.code === code)?.hash ?? "");
  useEffect(() => { hashOf(L, code).then(setHash); }, [L, code]);
  const at = note.cells.findIndex((c) => c.hash === hash), cell: Cell = { lang: L, code, hash, line: at >= 0 ? note.cells[at].line : 0 };
  return <CellView cell={cell} n={at >= 0 ? at + 1 : "·"} run={hash ? runs[hash] ?? note.outputs[hash] : undefined} sealed={note.sealed} look={look} onRun={() => onRun(cell)} onStop={() => onStop(cell)} />;
}
/** server/note.ts cellHash, in the page. */
async function hashOf(lang: Lang, code: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${lang}\n${code}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
/** a/b/../c → a/c */
const normalise = (p: string) => p.split("/").reduce<string[]>((o, s) => (s === ".." ? o.slice(0, -1) : s && s !== "." ? [...o, s] : o), []).join("/");
type Ask = { title: string; label?: string; value?: string; danger?: boolean; note?: string; ok: string; run: (v: string) => void };
const isTheme = (v: unknown): v is Theme => v === "light" || v === "dark" || v === "system";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isStr = (v: unknown): v is string => typeof v === "string";
const isList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
// the editor asks the hub's running session (lint, complete): /api/ask answers only while one runs
const SESSIONS: Record<Lang, Session> = {
  julia: { request: (op, args) => api.ask("julia", op, args) },
  python: { request: (op, args) => api.ask("python", op, args) },
};
// the window's sketch for the Panels key's previews (64 × 44)
const LAYOUT = { l: [4, 4, 14, 36], m: [20, 4, 26, 36], r: [48, 4, 12, 36] } as const satisfies Record<string, [number, number, number, number]>;

export function App() {
  const [theme, setTheme] = useState<Theme>(() => readStored("paperboat.theme", isTheme) ?? "system");
  const shown = useTheme(theme);
  // Settings › Editor: the note's editor, its cells and the other files
  // ponytail: in this browser's localStorage, as Julix's; the shared settings file once Malachite has a ConfigStore
  const [editor, setEditor] = useEditorSettings(undefined, "malachite.editor");
  const look: CodeLook = useMemo(() => ({ settings: editor, appTheme: shown }), [editor, shown]);
  const prose = useMemo(() => ({ ...editor, wrap: true }), [editor]);   // a note's text always wraps
  const [ws, setWs] = useState<Workspace | null | undefined>(undefined);   // undefined: not asked yet; null: the Start page
  const [home, setHome] = useState<string>();
  const [recent, setRecent] = useState<RecentEntry[]>([]);   // $PAPERBOAT_HOME/recent.json, every app's
  const [dlg, setDlg] = useState<"" | "connect" | "open" | "save" | "folder" | "file">("");
  const [notHub, setNotHub] = useState<{ name: string; path: string } | null>(null);
  const [unsaved, setUnsaved] = useState<{ closing?: string; then: () => void } | null>(null);
  const [hub, setHub] = useState<HubConf | null>(null);
  const [hubs, setHubs] = useState<KnownHub[]>([]);
  const [settings, setSettings] = useState<string | null>(null);   // the page Settings is open on
  const [restored, setRestored] = useState(0);
  const [apps, setApps] = useState<{ name: string; label: string }[]>([]);   // installed beside Malachite: they open their own files   // a restored note redraws its editor from the file
  const [tree, setTree] = useState<Entry[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [page, setPage] = useState<Page>("notes");
  const [wide, setWide] = useState(() => readStored("malachite.rail.wide", isBool) ?? false);
  const [hideL, setHideL] = useState(false), [hideR, setHideR] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false), [trashVersion, setTrashVersion] = useState(0);
  // the open tabs, kept per hub (read when the hub opens)
  const [tabs, setTabs] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const [revealed, setRevealed] = useState<string | null>(null);   // Reveal in Files: the row the tree shows
  const [note, setNote] = useState<NoteData | null>(null);
  const [plain, setPlain] = useState<string | null>(null);   // a text file that isn't a note
  const [mode, setMode] = useState<Mode>("live");
  const [cellEls, setCellEls] = useState<{ el: HTMLElement; lang: string; code: string }[]>([]);
  const [embedEls, setEmbedEls] = useState<{ el: HTMLElement; target: string; alt: string; wiki: boolean }[]>([]);
  const [ctx, setCtx] = useState<{ x: number; y: number; at: number | null } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [links, setLinks] = useState<Links | null>(null);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [peekVersion, setPeekVersion] = useState(0);
  const [log, setLog] = useState<LogEvent[]>([]);
  const [search, setSearch] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [about, setAbout] = useState<{ format?: number; paperboat?: string | null } | null>(null);
  const notes = useToasts();
  const { toasts, show, dismiss } = notes;
  const fail = useCallback((e: unknown) => show({ title: "Couldn't do that", detail: String((e as Error).message ?? e), state: "failed" }), [show]);
  const currentRef = useRef(current);
  currentRef.current = current;
  const sessionNote = useRef<Partial<Record<Lang, number>>>({});
  const saveNote = useRef<number | undefined>(undefined);   // a failed save's toast; the next save that works ends it

  const wsId = ws?.hub ?? null;
  const wsRef = useRef(wsId);
  wsRef.current = wsId;
  // the theme every app starts in ($PAPERBOAT_HOME/settings.json); this browser's copy draws the first frame
  useEffect(() => writeStored("paperboat.theme", theme), [theme]);
  const changeTheme = (t: Theme) => { setTheme(t); api.setTheme(t).catch(fail); };
  useEffect(() => writeStored("malachite.rail.wide", wide), [wide]);
  useEffect(() => { if (wsId) writeStored(`malachite.tabs:${wsId}`, tabs); }, [tabs]);
  useEffect(() => { if (wsId) writeStored(`malachite.tab:${wsId}`, current); }, [current]);
  useEffect(() => { if (wsId) writeStored(`malachite.pinned:${wsId}`, [...pinned]); }, [pinned]);
  const strip = useMemo(() => orderTabs(tabs, pinned), [tabs, pinned]);

  const reload = useCallback(() => { api.tree().then(setTree, fail); api.index().then(setItems, fail); }, [fail]);
  const loadRecent = useCallback(() => api.recent().then((r) => setRecent(r.recent), () => {}), []);
  const loadWs = useCallback(() => api.workspace().then((r) => { setWs(r.workspace); setHome(r.home); if (r.notHub) setNotHub(r.notHub); }, fail), [fail]);
  useEffect(() => {
    loadWs();
    api.settings().then((v) => setTheme(v.theme), () => {});
    api.apps().then(setApps, () => setApps([]));
  }, [loadWs]);
  // a file to open once its hub is open: a deep link (/?open=<path in the hub>&mode=edit), a file opened from outside
  const pending = useRef<{ path: string; mode: Mode } | null>((() => {
    const u = new URLSearchParams(location.search), p = u.get("open"), m = u.get("mode");
    return p ? { path: p, mode: m === "edit" || m === "read" ? m : "live" } : null;
  })());
  // a hub opens: its tabs, its files, its settings; none: the Start page
  useEffect(() => {
    api.hubs().then(setHubs, () => setHubs([]));
    loadRecent();
    setTabs(wsId ? readStored(`malachite.tabs:${wsId}`, isList) ?? [] : []);
    setCurrent(wsId ? readStored(`malachite.tab:${wsId}`, isStr) ?? null : null);
    setPinned(new Set(wsId ? readStored(`malachite.pinned:${wsId}`, isList) ?? [] : []));
    setDraft(null); setLog([]); setRuns({}); setTrashOpen(false);
    if (!wsId) { setHub(null); setTree([]); setItems([]); document.title = "Malachite"; return; }
    const go = pending.current;
    pending.current = null;
    if (go) open(go.path, false, go.mode);
    api.hub().then((v) => {
      setHub(v); document.title = `${v.name} · Malachite`;
      if (v.conflicts.length) show({ title: `${v.conflicts.length === 1 ? "A conflict copy" : `${v.conflicts.length} conflict copies`} in ${v.name}`, state: "failed",
        detail: `${v.conflicts.slice(0, 3).join(", ")}${v.conflicts.length > 3 ? ", …" : ""} · two machines changed the same file: keep what you want, trash the other` });
    },
      (e) => show({ title: "Couldn't open the hub", detail: `${(e as Error).message ?? e} · the terminal running malachite says why`, state: "failed" }));
    reload();
  }, [wsId]);

  const load = useCallback((p: string | null) => {
    if (!p) { setNote(null); setPlain(null); setLinks(null); return; }
    const t = typeOf(p);
    if (t === "md") {
      api.note(p).then((n) => { if (currentRef.current === p) { setNote(n); setPlain(null); setDraft(null); } }, fail);
      api.links(p).then((l) => currentRef.current === p && setLinks(l), () => setLinks(null));
    } else {
      setNote(null);
      setLinks(null);
      if (TEXT.has(t)) api.text(p).then((s) => { if (currentRef.current === p) { setPlain(s); setDraft(null); } }, fail); else setPlain(null);
    }
  }, [fail]);
  useEffect(() => { setRuns({}); load(current); }, [current, load]);

  // live: the hub (switched here or in another tab), files (anyone's changes), cells, sessions and the log
  useEffect(() => listen((e) => {
    if (e.type === "workspace") loadWs();
    else if (e.type === "files") {
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
      // a session starting is background work (a container may be pulled): one toast, working, then its end
      const name = e.lang === "julia" ? "Julia" : "Python", id = sessionNote.current[e.lang as Lang];
      if (e.state === "starting") sessionNote.current[e.lang as Lang] = show({ title: `Starting the ${name} session`, detail: "the cell runs once it is up", state: "working" });
      else if (id && e.state === "running") show({ id, title: `${name} session started`, state: "done" });
      else if (id && e.state === "failed") show({ id, title: `${name} session didn't start`, detail: `${e.error} · the Runtimes key in the bar`, state: "failed" });
      if (e.state !== "starting") delete sessionNote.current[e.lang as Lang];
      setPeekVersion((v) => v + 1);
    } else if (e.type === "log") {
      setLog((l) => [e.event, ...l].slice(0, 300));
      const c = currentRef.current;
      if (c && typeOf(c) === "md") api.links(c).then((l) => currentRef.current === c && setLinks(l), () => {});
    }
  }), [reload, load, show, loadWs]);
  useEffect(() => { if (page === "log") api.log().then(setLog, fail); }, [page, fail]);

  /** Opens a file in a tab (to the side: behind the current one); a note opens in Read unless asked. */
  const open = useCallback((p: string, side = false, view: Mode = "live") => {
    setPage("notes");
    if (!side) { setMode(view); api.opened(p).then(loadRecent, () => {}); }   // Open recent's files
    setTabs((t) => (t.includes(p) ? t : side ? [...t, p] : [p, ...t].slice(0, 12)));
    if (!side) setCurrent(p);
  }, [loadRecent]);
  /** Closes tabs (kit tabs.ts): what is typed in the shown one is saved first; its neighbour shows. */
  const closeTabs = (paths: string[]) => {
    if (current && paths.includes(current)) flush.current();
    const next = afterClose(strip, current, paths);
    setTabs(next.tabs);
    setCurrent(next.current);
    setPinned((s) => new Set([...s].filter((t) => !paths.includes(t))));
  };
  useEffect(() => {
    const pg = new URLSearchParams(location.search).get("page");
    if (pg === "graph" || pg === "views" || pg === "log") setPage(pg);
  }, []);

  const resolve = useMemo(() => {
    const byName = new Map<string, string>();
    for (const it of items) { byName.set(it.name.toLowerCase(), it.path); byName.set(nameOf(it.path).toLowerCase(), it.path); }
    const paths = new Set(items.map((i) => i.path));
    return (l: string) => (paths.has(l) ? l : paths.has(`${l}.md`) ? `${l}.md` : byName.get(l.toLowerCase()) ?? null);
  }, [items]);
  const allLinks = useMemo(() => hubLinks(items, resolve), [items, resolve]);

  const save = useCallback(async (p: string, text: string) => {
    try {
      await api.save(p, text);
      setDraft((d) => (d === text ? null : d));   // typed on while it saved: that stays to save next
      api.note(p).then((n) => currentRef.current === p && setNote(n), () => {});   // the note as saved (properties, cells)
      if (saveNote.current) show({ id: saveNote.current, title: "Saved", detail: p, state: "done" });
      saveNote.current = undefined;
    } catch (e) {
      saveNote.current = show({ id: saveNote.current, title: `Couldn't save ${nameOf(p)}`, detail: `${(e as Error).message ?? e} · what you typed is still here; Ctrl S tries again`, state: "failed" });
    }
  }, [show]);
  // save what is typed after a pause (and on Ctrl+S); the file is the record
  useEffect(() => {
    if (draft === null || !current || unsaved) return;   // asking Save or Don't save: it waits for the answer
    const t = setTimeout(() => save(current, draft), 700);
    return () => clearTimeout(t);
  }, [draft, current, save, unsaved]);
  const flush = useRef(async () => {});
  flush.current = async () => { if (draft !== null && current) await save(current, draft); };

  const newNote = useCallback((dir = current ? dirOf(current) : "") => setAsk({
    title: "New note", label: "Title", ok: "Create",
    run: (title) => api.create(dir, title).then((r) => { reload(); open(r.path, false, "live"); }, fail),
  }), [current, open, reload, fail]);

  const actions: FileActions = {
    open, newNote,
    newFolder: (dir) => setAsk({ title: "New folder", label: "Name", ok: "Create", run: (n) => api.folder(dir ? `${dir}/${n}` : n).then(reload, fail) }),
    rename: (p) => setAsk({
      title: "Rename", label: "Path in the hub", value: p, ok: "Rename",
      run: (to) => to !== p && api.move(p, to).then(() => { reload(); setTabs((t) => t.map((x) => (x === p ? to : x))); setPinned((s) => new Set([...s].map((x) => (x === p ? to : x)))); if (current === p) setCurrent(to); }, fail),
    }),
    trash: (p) => setAsk({ title: `Move ${p} to the trash?`, danger: true, ok: "Move to trash", run: () => api.trash(p).then(() => { reload(); closeTabs([p]); setTrashVersion((n) => n + 1); }, fail) }),
    seal: (p) => setAsk({
      title: `Seal ${p}?`, ok: "Seal", danger: true,
      run: () => api.seal(p).then(() => load(p), fail),
    }),
    copy: (text, what) => navigator.clipboard.writeText(text).then(() => show({ title: `${what} copied`, detail: text, state: "done" }), fail),
    reveal: (p) => { api.reveal(p).catch(fail); },
    graph: (p) => { open(p); setPage("graph"); },
    backlinks: (p) => { open(p); setHideR(false); },
    backlinkCount: (p) => allLinks.filter((l) => l.to === p).length,
    sealed: (p) => !!items.find((i) => i.path === p)?.props.sealed,
  };
  // a right click on a tab (REBRAND "Tab menu"): the tab's group, then the file's menu without Open
  const tabItems = (p: string) => {
    const e = entries.find((x) => x.path === p);
    return tabMenu(p, { tabs: strip, pinned, dirty: (t) => t === current && draft !== null }, {
      close: closeTabs,
      pin: (t, on) => setPinned((s) => { const n = new Set(s); if (on) n.add(t); else n.delete(t); return n; }),
      reveal: (t) => { setPage("notes"); setTrashOpen(false); setHideL(false); setRevealed(t); },
      file: e ? fileMenu(e, actions, true) : [],
    });
  };
  useEffect(() => setRevealed(null), [current]);
  // ponytail: a row inside a folder the reader collapsed stays hidden; open its folders if that bites
  useEffect(() => { if (revealed) document.querySelector(`.file-row[title="${CSS.escape(revealed)}"]`)?.scrollIntoView({ block: "nearest" }); }, [revealed]);

  // the hub's files as the kit's tree rows
  const [entries, sizes] = useMemo(() => {
    const out: FileEntry[] = [], sizes = new Map<string, number>();
    const conflict = new Set(hub?.conflicts ?? []);   // a sync client's copy: marked so it gets looked at
    const walk = (es: Entry[], depth: number) => { for (const e of es) { if (e.size !== undefined) sizes.set(e.path, e.size); out.push({ path: e.path, name: e.name, depth, kind: e.kind === "dir" ? "folder" : "file", ...(conflict.has(e.path) ? { badge: "conflict" } : {}) }); if (e.children) walk(e.children, depth + 1); } };
    walk(tree, 0);
    return [out, sizes] as const;
  }, [tree, hub?.conflicts]);

  const runCell = (c: Cell) => { if (current) api.run(current, c.hash).then((r) => setRuns((m) => ({ ...m, [c.hash]: r })), fail); };
  const stopCell = (c: Cell) => { api.interrupt(c.lang).catch(fail); };
  const onLink = (target: string, missing: boolean) => {
    if (!missing) return open(target);
    setAsk({ title: `Create ${target}?`, label: "Title", value: target, ok: "Create", run: (t) => api.create(current ? dirOf(current) : "", t).then((r) => { reload(); open(r.path); }, fail) });
  };

  // Live: the editor with the kit's live preview; its links open like Read's, its cells are Read's cells
  // (drawn into the editor, run after a save), its properties the table above it
  const liveView = useRef<EditorView | null>(null);
  const liveAct = useRef({ link: (_t: string, _w: boolean) => {}, run: (_c: Cell) => {} });
  liveAct.current = {
    link: (t, wiki) => {
      if (/^[a-z]+:/i.test(t)) { window.open(t, "_blank", "noopener"); return; }
      const p = wiki ? resolve(t) : resolve(normalise(current ? `${dirOf(current)}/${t}` : t));
      onLink(p ?? t, !p);
    },
    run: async (cell) => {
      const v = liveView.current;
      if (!current || !cell.hash) return;
      if (v && draft !== null) await save(current, v.state.doc.toString());
      runCell(cell);
    },
  };
  const live = useMemo(() => livePreview({
    onLink: (t, w) => liveAct.current.link(t, w), frontMatter: "hide",
    cells: {
      langs: ["julia", "jl", "python", "py"],
      mount: (el, c) => setCellEls((l) => [...l, { el, ...c }]),
      unmount: (el) => setCellEls((l) => l.filter((x) => x.el !== el)),
    },
    embeds: {
      mount: (el, e) => setEmbedEls((l) => [...l, { el, ...e }]),
      unmount: (el) => setEmbedEls((l) => l.filter((x) => x.el !== el)),
    },
  }), []);

  /** A picture, a video or a sound, wherever a note embeds one (Read, Live) and in the file view. */
  const mediaFor = (path: string | null, alt: string) => (
    <MediaEmbed path={path} alt={alt} version={path ? items.find((i) => i.path === path)?.mtime : undefined} fail={fail}
      onSaved={(p) => { reload(); show({ title: "Saved", detail: `${p} · the original is in the trash`, state: "done" }); }} />
  );
  /** An embed as Live found it: a wikilink's target resolved, a Markdown path from the note's folder. */
  const embedPath = (target: string, wiki: boolean) => (wiki ? resolve(target) : /^[a-z][\w+.-]*:/i.test(target) ? null : resolve(normalise(current ? `${dirOf(current)}/${decodeURI(target)}` : decodeURI(target))));

  // files dropped or pasted into a note: uploaded beside it, embedded on the line where they fell
  const dropAct = useRef(async (_files: File[], _at: number | null) => {});
  dropAct.current = async (files, at) => {
    const v = liveView.current;
    if (!v || !current || note?.sealed) return;
    const dir = dirOf(current), stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-"), lines: string[] = [];
    const id = show({ title: `Adding ${files.length === 1 ? files[0].name || "a file" : `${files.length} files`}`, state: "working" });
    try {
      for (const [i, f] of files.entries()) {
        const ext = f.name.includes(".") ? "" : `.${(f.type.split("/")[1] ?? "bin").replace("jpeg", "jpg").replace(/\W.*/, "")}`;
        const name = !f.name || f.name === "image.png" ? `pasted-${stamp}${files.length > 1 ? `-${i + 1}` : ""}.${f.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png"}` : f.name + ext;
        const r = await api.upload(dir ? `${dir}/${name}` : name, f);
        const short = nameOf(r.path), clash = items.some((x) => x.path !== r.path && nameOf(x.path) === short);
        lines.push(`${mediaOf(r.path) ? "!" : ""}[[${clash ? r.path : short}]]`);
      }
      const text0 = v.state.doc.toString(), front = text0.length - split(text0).body.length;
      const want = at ?? v.state.selection.main.head, line = v.state.doc.lineAt(want < front ? v.state.doc.length : want);
      const insert = `${line.text.trim() ? "\n" : ""}${lines.join("\n")}\n`;
      v.dispatch({ changes: { from: line.to, insert }, selection: { anchor: line.to + insert.length } });
      reload();
      show({ id, title: `Added ${lines.length === 1 ? "a file" : `${lines.length} files`}`, detail: dir || "the hub's root", state: "done" });
    } catch (e) { show({ id, title: "Couldn't add it", detail: `${(e as Error).message ?? e} · the note is unchanged`, state: "failed" }); }
  };
  const dropExt = useMemo(() => EditorView.domEventHandlers({
    drop(e, view) {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return false;
      e.preventDefault();
      dropAct.current(files, view.posAtCoords({ x: e.clientX, y: e.clientY }));
      return true;
    },
    paste(e) {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return false;
      e.preventDefault();
      dropAct.current(files, null);
      return true;
    },
  }), []);
  const liveExt = useMemo(() => [live, dropExt], [live, dropExt]);
  /** The properties table's change, made in the editor (so it undoes, and saves like typing). */
  const setProps = (next: Props) => {
    const v = liveView.current;
    if (!v) return;
    const text = v.state.doc.toString(), { body } = split(text), joined = patch(text, next);
    v.dispatch({ changes: { from: 0, to: text.length - body.length, insert: joined.slice(0, joined.length - body.length) } });
  };
  /** A new cell below the line at `at` (where the menu was opened; else the caret), the caret in it; never
   *  inside the front matter (hidden in Live, and the caret starts there). */
  const insertCell = (lang: Lang, at?: number | null) => {
    const v = liveView.current;
    if (!v || mode === "read") return;
    const text0 = v.state.doc.toString(), front = text0.length - split(text0).body.length;
    const want = at ?? v.state.selection.main.head, pos = want < front ? v.state.doc.length : want;   // no caret in the text yet: at its end
    const line = v.state.doc.lineAt(pos), blank = !line.text.trim();
    const from = blank ? line.from : line.to, lead = blank ? "" : "\n\n", text = `${lead}\`\`\`${lang}\n\n\`\`\`\n`;
    v.dispatch({ changes: { from, to: blank ? line.to : from, insert: text }, selection: { anchor: from + lead.length + 4 + lang.length } });
    v.focus();
  };
  const noteMenu = (at?: number | null): MenuEntry[] => [
    { id: "jl", label: "Insert Julia cell", icon: "add", disabled: !!note?.sealed, why: "It is sealed", run: () => insertCell("julia", at) },
    { id: "py", label: "Insert Python cell", icon: "add", disabled: !!note?.sealed, why: "It is sealed", run: () => insertCell("python", at) },
  ];

  // About asks the server for the hub format and Paperboat's version as it opens
  const openAbout = () => { setAbout({}); api.about().then((r) => setAbout((a) => a && r), () => {}); };

  // ── the one file workflow (plans/2026-11-26_11-05_one_file_workflow.md): Malachite works in hubs only ──
  /** A hub opened (or none): its file, when one was asked for, opens in it. */
  const enter = (r: Entered) => {
    // the hub may be open here already (this hub, or the server's event came first): then the file opens now
    if (r.open) { if ((r.workspace?.hub ?? null) === wsRef.current) open(r.open); else pending.current = { path: r.open, mode: "live" }; }
    setWs(r.workspace);
    setDlg("");
    loadRecent();
  };
  /** A folder or a file by its path: its hub opens; a plain folder asks to become one (NotAHub). */
  const openPath = (p: string, make = false) => {
    flush.current();
    api.enter({ path: p, make }).then(enter, (e) => {
      const nh = (e as { body?: { notHub?: { name: string; path: string } } }).body?.notHub;
      if (nh) { setDlg(""); setNotHub(nh); } else fail(e);
    });
  };
  /** What is typed and not yet saved asks first (Save, Don't save, Cancel), then `then` runs. */
  const guard = (closing: string | undefined, then: () => void) => {
    if (draft !== null && current) setUnsaved({ closing, then }); else then();
  };
  const switchHub = (id: string) => guard("the hub", () => api.enter({ id }).then(enter, fail));
  const closeHub = () => guard("the hub", () => api.enter({}).then(enter, fail));
  const closeFile = () => current && guard(undefined, () => { setDraft(null); closeTabs([current]); });
  const newHub = () => setAsk({ title: "New hub", label: "Name", ok: "Create", note: "It goes in ~/Documents/paperboat, and Malachite works in it.",
    run: (n) => guard("the hub", () => api.hubNew(n).then(enter, fail)) });
  // the system's dialogs in a Paperboat window; in a browser, the path typed
  const openFolder = () => { const sh = shell(); if (sh) sh.pickFolder("Open a hub or a folder").then((p) => p && openPath(p), fail); else setDlg("folder"); };
  const openFile = () => {
    if (ws) return setDlg("open");   // in a hub: our picker over it
    const sh = shell();
    if (sh) sh.pickFile(["md"], "Open a note").then((p) => p && openPath(p), fail); else setDlg("file");
  };
  const onRecent = (e: RecentEntry) => (e.kind === "hub" && e.hub && hubs.some((h) => h.id === e.hub && !h.missing) ? switchHub(e.hub) : openPath(e.path));
  const recentItems = recentMenu(recentFor({ version: 1, recent }, "malachite", { folders: false }), onRecent, () => { api.clearRecent().then(loadRecent, fail); });
  /** Save as…: the text into another file in the hub (a note without the old one's id and seal: it is another
   *  note), then that file shows. Onto itself it is Save. */
  const saveAs = (to: string) => {
    if (!current) return;
    if (to === current) { setDlg(""); flush.current(); return; }
    let text = draft ?? note?.text ?? plain ?? "";
    if (typeOf(current) === "md") { const { props, body } = split(text); for (const k of ["id", "sealed", "sealed_by", "hash"]) delete props[k]; text = join(props, body); }
    setDlg("");
    api.save(to, text).then(() => { setDraft(null); reload(); open(to); }, fail);
  };

  // ── the commands: the menu bar, the command search (Ctrl K) and the shortcuts read this one list ──
  const MENUS: CommandMenu[] = [{ id: "file", label: "File" }, { id: "edit", label: "Edit" }, { id: "view", label: "View" }, { id: "note", label: "Note" }, { id: "help", label: "Help" }];
  const noHub = ws ? {} : { enabled: false, why: "no hub open" };
  const needNote = (more = true) => (note && more ? {} : { enabled: false, why: note ? "not here" : "open a note first" });
  const editing = () => !!note && !note.sealed && mode !== "read" && !!liveView.current;
  const commands: Command[] = [
    ...fileCommands({
      noun: "note", workspace: ws ?? null, file: !!ws && !!current, hubs: true, hubOnly: true, recent: recentItems,
      onNew: () => (ws ? newNote() : setDlg("connect")), onOpenFile: openFile, onOpenFolder: openFolder, onConnect: () => setDlg("connect"),
      onSave: () => { flush.current(); }, onSaveAs: () => setDlg("save"), onCloseFile: closeFile, onCloseWorkspace: closeHub, onSettings: () => setSettings("general"),
    }),
    { id: "edit.undo", label: "Undo", menu: "edit", group: "undo", shortcut: "Ctrl Z", enabled: editing, why: "nothing to undo here", run: () => { const v = liveView.current; if (v) undo(v); } },
    { id: "edit.redo", label: "Redo", menu: "edit", group: "undo", shortcut: "Ctrl Shift Z", enabled: editing, why: "nothing to redo here", run: () => { const v = liveView.current; if (v) redo(v); } },
    { id: "edit.rename", label: "Rename…", menu: "edit", group: "file", ...(current ? {} : { enabled: false, why: "no file open" }), run: () => current && actions.rename(current) },
    { id: "edit.link", label: "Copy link", menu: "edit", group: "file", ...(current ? {} : { enabled: false, why: "no file open" }), run: () => current && actions.copy(`[[${nameOf(current).replace(/\.md$/, "")}]]`, "Link") },
    { id: "edit.path", label: "Copy path", menu: "edit", group: "file", ...(current ? {} : { enabled: false, why: "no file open" }), run: () => current && actions.copy(current, "Path") },
    { id: "edit.trash", label: "Move to trash", menu: "edit", group: "file", ...(current ? {} : { enabled: false, why: "no file open" }), run: () => current && actions.trash(current) },
    { id: "edit.search", label: `Search ${hub?.name ?? "the hub"}…`, menu: "edit", group: "find", shortcut: "Ctrl K", chord: { key: "k", ctrl: true }, quiet: true, ...noHub, run: () => setSearch((o) => !o) },
    ...(["notes", "views", "graph", "log"] as Page[]).map((p, i): Command => ({ id: `view.${p}`, label: `${p[0].toUpperCase()}${p.slice(1)}`, menu: "view", group: "pages", shortcut: `Alt ${i + 1}`, checked: !!ws && page === p, ...noHub, run: () => setPage(p) })),
    { id: "view.files", label: "Files", menu: "view", group: "panels", shortcut: "Ctrl B", chord: { key: "b", ctrl: true }, checked: !!ws && !hideL, ...noHub, run: () => setHideL((h) => !h) },
    { id: "view.links", label: "Links", menu: "view", group: "panels", shortcut: "Ctrl Alt B", chord: { key: "b", ctrl: true, alt: true }, checked: !!ws && !hideR, ...noHub, run: () => setHideR((h) => !h) },
    ...(["read", "live", "edit"] as Mode[]).map((m): Command => ({ id: `view.${m}`, label: m === "edit" ? "Edit the Markdown" : m[0].toUpperCase() + m.slice(1), menu: "view", group: "mode", checked: !!note && mode === m, ...needNote(), run: () => setMode(m) })),
    { id: "view.theme", label: "Theme", menu: "view", group: "theme", quiet: true, run: () => {},
      sub: THEMES.map((t): MenuEntry => ({ id: `theme.${t}`, label: t[0].toUpperCase() + t.slice(1), checked: theme === t, run: () => changeTheme(t) })) },
    ...noteMenu().flatMap((m): Command[] => (typeof m === "object" && "run" in m ? [{ id: `note.${m.id}`, label: m.label, menu: "note", group: "cells", ...needNote(mode !== "read" && !m.disabled), run: m.run }] : [])),
    { id: "note.seal", label: "Seal…", icon: "lock", menu: "note", group: "note", ...needNote(!note?.sealed), run: () => note && actions.seal(note.path) },
    { id: "note.graph", label: "Show in graph", menu: "note", group: "note", ...needNote(), run: () => note && actions.graph(note.path) },
    { id: "note.jl", label: "Restart the Julia session", menu: "note", group: "sessions", ...noHub, run: () => { api.restart("julia").catch(fail); } },
    { id: "note.py", label: "Restart the Python session", menu: "note", group: "sessions", ...noHub, run: () => { api.restart("python").catch(fail); } },
    { id: "note.trash", label: "Show the trash", menu: "note", group: "trash", ...noHub, run: () => { setPage("notes"); setHideL(false); setTrashOpen(true); } },
    { id: "note.empty", label: "Empty the trash…", menu: "note", group: "trash", ...noHub,
      run: () => setAsk({ title: "Empty the trash?", note: "Everything in it leaves the hub for good; it can't be restored.", danger: true, ok: "Empty trash", run: () => api.emptyTrash().then(() => setTrashVersion((n) => n + 1), fail) }) },
    { id: "help.docs", label: "Malachite docs", menu: "help", group: "docs", icon: "link-external", run: () => { window.open("https://paperboatlab.org/apps/malachite/", "_blank", "noopener"); } },
    { id: "help.issue", label: "Report an issue…", menu: "help", group: "docs", icon: "link-external", run: () => { window.open("https://github.com/paperboatlab/malachite/issues/new", "_blank", "noopener"); } },
    { id: "help.keys", label: "Keyboard shortcuts", menu: "help", group: "keys", icon: "keys", shortcut: "Ctrl /", chord: { key: "/", ctrl: true }, run: () => setSettings("shortcuts") },
    { id: "help.about", label: "About Malachite", menu: "help", group: "about", run: () => openAbout() },
  ];
  useShortcuts(commands);
  const searchItems: SearchItem[] = [
    ...items.filter((i) => i.type === "md").map((i): SearchItem => ({ id: `n:${i.path}`, label: i.title, detail: i.path, group: "Notes", scope: "Notes", icon: "markdown", run: () => open(i.path) })),
    ...items.filter((i) => i.type !== "md").map((i): SearchItem => ({ id: `f:${i.path}`, label: nameOf(i.path), detail: dirOf(i.path), group: "Files", scope: "Files", icon: "file", run: () => open(i.path) })),
    ...[...new Set(items.flatMap((i) => i.tags))].sort().map((t): SearchItem => ({ id: `t:${t}`, label: `#${t}`, detail: `${items.filter((i) => i.tags.includes(t)).length} notes`, group: "Tags", scope: "Notes", icon: "tag", run: () => setPage("views") })),
    ...commands.filter((c) => !c.quiet && !c.sub).map((c): SearchItem => ({
      id: `c:${c.id}`, label: c.label, shortcut: c.shortcut, group: MENUS.find((m) => m.id === c.menu)?.label ?? "Commands", scope: "Commands", icon: c.icon, disabled: !isEnabled(c), why: c.why, run: c.run,
    })),
  ];

  /** Our picker's preview of a note: its title, when it changed, its size. */
  const describe = (e: FileEntry) => {
    const it = items.find((i) => i.path === e.path), size = sizes.get(e.path);
    return it && <>
      {it.title !== nameOf(e.path) && <small>{it.title}</small>}
      <small>changed {new Date(it.mtime).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}{size === undefined ? "" : ` · ${size < 1e3 ? `${size} B` : size < 1e6 ? `${(size / 1e3).toFixed(1)} kB` : `${(size / 1e6).toFixed(1)} MB`}`}</small>
    </>;
  };

  const t = current ? typeOf(current) : "";
  const nRunning = Object.values(running).filter(Boolean).length;
  const mdCount = items.filter((i) => i.type === "md").length;

  return (
    <div className={`win frame${ws ? "" : " start"}`}>
      <header className="bar">
        <span className="lk"><AppMark app="malachite" size={26} idle label="Malachite" /><span className="wm">Malachite</span></span>
        <MenuBar commands={commands} menus={MENUS} />
        {ws && <WorkspaceWell workspace={ws} home={home} recent={recentItems} hubs={hubs.map(kitHub)} onOpenFolder={openFolder} onConnect={() => setDlg("connect")}
          onClose={closeHub} onSwitchHub={switchHub} onNewHub={newHub} />}
        <span className="bend">
          {ws && page === "notes" && <Key kind="primary" icon="new-file" onClick={() => newNote()}>New note</Key>}
          <Runtimes running={nRunning} version={peekVersion} />
          <Notifications {...notes} />
          {ws && page === "notes" && <PanelsKey layout={LAYOUT} onToggle={(id) => (id === "l" ? setHideL : setHideR)((h) => !h)}
            panels={[{ id: "l", label: "Files", keys: "Ctrl B", shown: !hideL }, { id: "r", label: "Links", keys: "Ctrl Alt B", shown: !hideR }]} />}
          <WindowKeys />
        </span>
      </header>

      {ws && <Rail label="Malachite pages" wide={wide} onWide={setWide} page={page} onPage={(p) => setPage(p as Page)}
        pages={[{ id: "notes", label: "Notes", icon: "a-notes", keys: "Alt+1", count: nRunning ? "live" : mdCount }, { id: "views", label: "Views", icon: "a-views", keys: "Alt+2" },
          { id: "graph", label: "Graph", icon: "a-trace", keys: "Alt+3" }, { id: "log", label: "Log", icon: "a-log", keys: "Alt+4" }]}
        foot={[{ id: "search", label: "Search", icon: "search", keys: "Ctrl+K" }, { id: "settings", label: "Settings", icon: "a-settings", keys: "Ctrl+," }, { id: "help", label: "Help", icon: "question", keys: "F1" }]}
        onFoot={(id) => { if (id === "search") setSearch(true); else if (id === "settings") setSettings("general"); else openAbout(); }} />}

      {!ws && <main className="pages"><div className="bay"><section className="panel start" aria-label="Start">
        {ws === null && <Start app="Malachite" noun="note" nouns="notes" hubs hubOnly recent={recent} home={home}
          onOpenFolder={openFolder} onOpenFile={openFile} onNew={() => setDlg("connect")} onConnect={() => setDlg("connect")} onNewHub={newHub} onRecent={onRecent} />}
      </section></div></main>}
      {ws && <main className="pages">
        {page === "notes" && (
          <div className="notes-page">
            <Panel name={trashOpen ? "Trash" : "Files"} count={trashOpen ? undefined : `${items.length}`} side="left" hidden={hideL} onHidden={setHideL} icon="a-notes" width={262}
              tools={<>
                {!trashOpen && <><Key size="sm" kind="quiet" round icon="new-file" label="New note (Ctrl N)" onClick={() => newNote("")} /><Key size="sm" kind="quiet" round icon="new-folder" label="New folder" onClick={() => actions.newFolder("")} /></>}
                <Key size="sm" kind="quiet" round icon="trash" label={trashOpen ? "Back to the hub" : "Trash"} aria-pressed={trashOpen} onClick={() => setTrashOpen((o) => !o)} />
              </>}>
              {trashOpen ? <TrashList version={trashVersion} fail={fail}
                confirm={(title, note, ok, run) => setAsk({ title, note, danger: true, ok, run })}
                onRestored={(p, was) => { reload(); if (p !== was) show({ title: "Restored under a new name", detail: `${was} as ${p}: its name was taken`, state: "done" }); }} />
              : <FileTree entries={entries} active={revealed ?? current ?? undefined} ariaLabel="Hub" menu={(e) => fileMenu(e, actions)}
                actions={{
                  onOpen: (e) => open(e.path), onRename: (e) => actions.rename(e.path), onDelete: (e) => actions.trash(e.path),
                  onCopyPath: (e) => actions.copy(e.path, "Path"),
                  onMove: (src, target) => { const to = target ? `${target.path}/${src.name}` : src.name; if (to !== src.path) api.move(src.path, to).then(reload, fail); },
                }} />}
            </Panel>

            <div className="bay">
            <section className="panel note" aria-label="Note">
              <EditorTabs label="Open notes" current={current} onShow={(p) => open(p)} onClose={(p) => closeTabs([p])} menu={tabItems}
                onUnpin={(p) => setPinned((s) => new Set([...s].filter((x) => x !== p)))}
                tabs={strip.map((p) => ({ id: p, label: nameOf(p).replace(/\.md$/, ""), pinned: pinned.has(p), dirty: p === current && draft !== null }))} />
              {current && (
                <div className="crumb">
                  <span>{hub?.name} / {current.split("/").slice(0, -1).map((d) => `${d} / `).join("")}<b>{nameOf(current)}</b></span>
                  <span className="row-end">
                    {(note || plain !== null) && <span>{unsaved ? "not saved" : draft !== null ? "saving…" : note?.sealed ? "sealed" : "saved"}</span>}
                    {note && !note.sealed && <Key size="sm" icon="lock" onClick={() => actions.seal(note.path)} title="Seal: freeze the body and record its hash">Seal…</Key>}
                  </span>
                </div>
              )}
              <div className="body">
                {!current && <div className="empty"><AppMark app="malachite" size={72} idle label="" /><p>Open a note from the hub, or make one.</p><Key kind="primary" icon="new-file" onClick={() => newNote("")}>New note</Key></div>}
                {note && mode === "read" && <ReadView note={note} runs={runs} resolve={resolve} look={look} onLink={onLink} onRun={runCell} onStop={stopCell} media={mediaFor} />}
                {note && mode !== "read" && (() => {
                  const editor = <Editor key={`${note.path}:${note.sealed}:${mode}:${restored}`} value={draft ?? note.text} language={markdown} settings={prose} appTheme={look.appTheme}
                    readOnly={note.sealed} ariaLabel={`${note.title}, Markdown`} onChange={setDraft}
                    extra={mode === "live" ? liveExt : dropExt} onView={(v) => { liveView.current = v; }} />;
                  return (
                    <div className={`edit ${mode}`} onContextMenu={(e) => { if ((e.target as HTMLElement).closest(".cm-editor")) { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, at: liveView.current?.posAtCoords({ x: e.clientX, y: e.clientY }) ?? null }); } }}>
                      {mode === "live" ? <div className="livecol">
                        <PropsEditor props={split(draft ?? note.text).props} sealed={note.sealed} onChange={setProps}
                          choices={(k) => valuesIn(items.filter((i) => i.type === "md"), k)}
                          ask={(title, value, ok, run) => setAsk({ title, label: "Value", value, ok, run: (v) => v.trim() && run(v.trim()) })} />
                        {editor}
                      </div> : editor}
                      {mode === "live" && embedEls.map((e) => createPortal(mediaFor(embedPath(e.target, e.wiki), e.alt || (embedPath(e.target, e.wiki) ? "" : e.target)), e.el))}
                      {mode === "live" && cellEls.map((c) => createPortal(
                        <LiveCell key="cell" lang={c.lang} code={c.code} note={note} runs={runs} look={look} onRun={(cell) => liveAct.current.run(cell)} onStop={stopCell} />, c.el))}
                      {ctx && <div className="ctxmenu" style={{ left: ctx.x, top: ctx.y }}><Menu label="Note" items={noteMenu(ctx.at)} onClose={() => setCtx(null)} /></div>}
                    </div>
                  );
                })()}
                {current && t !== "md" && <FileView path={current} text={plain} look={look} onChange={setDraft} media={mediaFor} apps={apps}
                  onApp={(app, copy) => { const label = apps.find((a) => a.name === app)?.label ?? app;
                    api.openIn(app, current, copy).then((r) => { window.open(r.url, label);  /* named: the Launcher opens it as that app's window */ show({ title: copy ? `Copied to ${label}` : `Opened in ${label}`, detail: copy ? `${r.folder}/${r.file} · not in the hub` : `${label} works in ${hub?.name ?? "the hub"}`, state: "done" }); }, fail); }} />}
              </div>
              {note && <div className="efoot"><span>markdown · {note.body.split(/\s+/).filter(Boolean).length} words · {note.cells.length} cells</span>
                <Segmented label="View" value={mode} onChange={setMode} options={[{ value: "read", label: "Read" }, { value: "live", label: "Live" }, { value: "edit", label: "Edit" }]} /><span>{links?.backlinks.length ?? 0} backlinks · {links?.links.length ?? 0} links</span></div>}
            </section>
            </div>

            <Panel name="Links" side="right" hidden={hideR} onHidden={setHideR} icon="references" width={300}>
              <LinksCard links={links} self={current ?? ""} onOpen={open} onCreate={(n) => onLink(n, true)}
                onRestore={(v) => current && setAsk({ title: `Restore ${nameOf(current)} as it was ${v.time.slice(0, 16).replace("T", " ")}?`, note: "The current version stays in its versions; you can come back to it.", ok: "Restore",
                  run: () => api.restoreVersion(v.id, current).then(() => api.note(current)).then((n) => { setNote(n); setDraft(null); setRestored((k) => k + 1); reload(); api.links(current).then(setLinks, () => {}); }, fail) })}
                graph={current && t === "md" ? <HubGraph focus={current} links={allLinks} items={items} local onOpen={open} /> : undefined} />
            </Panel>
          </div>
        )}
        {page !== "notes" && <div className="bay">
        {page === "graph" && (
          <Panel name="Graph" showName={false} count={`${mdCount} notes · ${allLinks.length} links`}>
            <HubGraph focus={current} links={allLinks} items={items} hub={wsId ?? undefined} onOpen={(p) => { open(p); setPage("notes"); }} />
          </Panel>
        )}
        {page === "log" && (
          <Panel name="Activity log" showName={false} count={`${log.length} events · .malachite/log`}>
            <div className="lev big">{log.map((e, i) => <Ev key={i} e={e} path />)}</div>
          </Panel>
        )}
        {page === "views" && (
          <ViewsPage items={items} onOpen={(p) => open(p)} fail={fail}
            ask={(title, value, ok, run) => setAsk({ title, label: "Name", value, ok, run: (n) => n.trim() && run(n.trim()) })} />
        )}
        </div>}
      </main>}

      {search && <Search items={searchItems} scopes={["All", "Notes", "Files", "Commands"]} placeholder={`Search ${hub?.name ?? "the hub"} or run a command`} onClose={() => setSearch(false)} />}
      {settings && <Settings app="Malachite" key={settings} page={settings} onClose={() => setSettings(null)} pages={[
        { id: "general", label: "General", icon: "settings-gear", body: <ThemeSetting theme={theme} onTheme={changeTheme} /> },
        { id: "malachite", label: "Malachite", icon: "mark-malachite", body: <>
          <SettingsSection title="Notes">
            <SettingRow label="A note opens in" hint="Read and Edit are in the note's foot and in View"><span className="set-fact">Live</span></SettingRow>
            <SettingRow label="Lines" hint="A note's text always wraps; Editor › Wrap lines is for its cells and other files"><span className="set-fact">Wrapped</span></SettingRow>
            <SettingRow label="Cells run" hint="In the hub's Julia or Python session, one each, started by the first cell; the Runtimes key shows them"><span className="set-fact">In the note's folder</span></SettingRow>
          </SettingsSection>
          <SettingsSection title="New hubs">
            <SettingRow label="Folder" hint="New hub makes them here; Connect to a hub… opens one anywhere"><span className="set-fact">~/Documents/paperboat</span></SettingRow>
          </SettingsSection>
          <p className="settings-note">Nothing here to change yet: this is how Malachite works today.</p>
        </> },
        { id: "editor", label: "Editor", icon: "file-code", body: <EditorSettingsPane settings={editor} onSettings={setEditor} lintNote="Julia and Python, by the hub's running session" /> },
        { id: "hub", label: "Hub", icon: "folder", body: hub
          ? <HubSettings hub={kitHub({ ...hub, shown: hub.shown })} values={{ author: hub.author, keep: hub.keep, ignore: hub.ignore }}
            onSet={(k, v) => api.hubSet(k as "author" | "keep" | "ignore", String(v)).then(setHub, fail)}
            onRename={() => setAsk({ title: "Rename the hub", label: "Name", value: hub.name, ok: "Rename", note: "The folder keeps its name; apps show this one.",
              run: (n) => n.trim() && api.hubSet("name", n.trim()).then((h) => { setHub(h); document.title = `${h.name} · Malachite`; api.hubs().then(setHubs); loadWs(); }, fail) })}
            onMove={() => show({ title: "Move the hub", detail: `Close it first, then: paperboat hub move ${hub.name} <folder>` })}
            onRemove={() => setAsk({ title: `Take ${hub.name} off the list?`, note: "Paperboat forgets it; the folder and its files stay. Opening it again adds it back.", danger: true, ok: "Remove from the list",
              run: () => api.hubForget(hub.id).then(() => api.hubs().then(setHubs), fail) })} />
          : <SettingsSection title="The hub">
            <SettingRow label="No hub open" hint="A hub's name, author, history and folder are set here once one is open">
              <Key size="sm" onClick={() => { setSettings(null); setDlg("connect"); }}>Connect to a hub…</Key>
            </SettingRow>
          </SettingsSection> },
        { id: "shortcuts", label: "Shortcuts", icon: "keys", body: <ShortcutList commands={commands} menus={MENUS} /> },
      ]} />}
      {dlg === "connect" && <ConnectHub app="Malachite" hubOnly hubs={hubs.map(kitHub)} onConnect={switchHub} onNew={newHub} onClose={() => setDlg("")} />}
      {dlg === "open" && ws && <OpenFile what="a note" types={["md"]} kinds="Notes" hub={kitHub(hubs.find((h) => h.id === ws.hub) ?? { id: ws.hub, name: ws.name, shown: ws.root, place: "local" })}
        list={async () => entries} describe={describe} onOpen={(p) => { setDlg(""); open(p); }} onClose={() => setDlg("")} />}
      {dlg === "save" && ws && current && <SaveFile what={typeOf(current) === "md" ? "the note" : "the file"} types={[typeOf(current)]} name={nameOf(current).replace(/\.[^.]+$/, "")}
        hub={kitHub(hubs.find((h) => h.id === ws.hub) ?? { id: ws.hub, name: ws.name, shown: ws.root, place: "local" })} list={async () => entries} onSave={saveAs} onClose={() => setDlg("")} />}
      {(dlg === "folder" || dlg === "file") && <TypedPath title={dlg === "folder" ? "Open folder" : "Open a local file"} what={dlg} onOpen={(p) => openPath(p)} onClose={() => setDlg("")} />}
      {notHub && <NotAHub name={notHub.name} onMake={() => { openPath(notHub.path, true); setNotHub(null); }} onOpenHub={() => { setNotHub(null); setDlg("connect"); }} onClose={() => setNotHub(null)} />}
      {unsaved && current && <Unsaved name={nameOf(current)} closing={unsaved.closing}
        onSave={() => { const then = unsaved.then; setUnsaved(null); flush.current().then(() => { setDraft(null); then(); }); }}
        onDiscard={() => { const then = unsaved.then; setUnsaved(null); setDraft(null); then(); }} onClose={() => setUnsaved(null)} />}
      {ask && <AskDialog ask={ask} onClose={() => setAsk(null)} />}
      {about && <About app="malachite" role="An engineering notebook: Markdown notes with Julia and Python cells" version={__VERSION__}
        paperboat={about.paperboat} repo="paperboatlab/malachite" credits={CREDITS} onClose={() => setAbout(null)}
        info={[about.format && `hub format ${about.format}`, __COMMIT__ && `commit ${__COMMIT__}`].filter(Boolean).join(" · ") || undefined} />}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

/** A hub as the kit draws it. */
const kitHub = (h: { id: string; name: string; shown: string; place: Place; missing?: boolean; conflicts?: string[]; notes?: number }): KitHub =>
  ({ id: h.id, name: h.name, place: h.place, path: h.shown, missing: h.missing, conflicts: h.conflicts?.length, holds: h.notes === undefined ? undefined : `${h.notes} note${h.notes === 1 ? "" : "s"}` });

/** A CSV's numeric columns against its first: what a run left behind, at a glance. */
function CsvPlot({ text }: { text: string }) {
  const plot = useMemo(() => {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 3) return null;
    const head = lines[0].split(",").map((h) => h.trim());
    const rows = lines.slice(1).map((l) => l.split(",").map(Number));
    const x = rows.map((r) => r[0]);
    if (!x.every(Number.isFinite)) return null;
    const series: PlotSeries[] = head.slice(1).map((label, i) => ({ label, x, y: rows.map((r) => r[i + 1]) })).filter((s) => s.y.every(Number.isFinite));
    return series.length ? { series, xlabel: head[0] } : null;
  }, [text]);
  if (!plot) return null;
  return <div className="fplot"><Plot2D series={plot.series} axes={{ xlabel: { text: plot.xlabel }, legend: { show: plot.series.length > 1 } }} /></div>;
}

/** A file that isn't a note: another app's (its name and type), an image, or text in the kit's editor
 *  with its language, linted and completed by the hub's session for Julia and Python. */
function FileView({ path, text, look, onChange, media, apps, onApp }: { path: string; text: string | null; look: CodeLook; onChange: (t: string) => void; media: (p: string, alt: string) => React.ReactNode; apps: { name: string; label: string }[]; onApp: (app: string, copy: boolean) => void }) {
  const t = typeOf(path), owner = OWNER[t], language = languageFor(path);
  const app = owner && apps.find((a) => a.label === owner || a.name === owner.toLowerCase());
  const session = language.runtime === "julia" || language.runtime === "python" ? SESSIONS[language.runtime] : undefined;
  return (
    <div className="fileview">
      {(owner || mediaOf(path) || text === null) && (
        <div className="fcard"><FileGlyph path={path} size={20} /><b>{nameOf(path)}</b>
          <small>{app ? `${owner}'s file: open it there on this hub, or copy it out to work on it alone.` : owner ? `${owner} draws this once it is installed (paperboat app install ${owner.toLowerCase()}); until then Malachite shows its text.` : mediaOf(path) ? `a ${mediaOf(path) === "image" ? "picture" : mediaOf(path)} in the hub` : "a file in the hub"}</small>
          {app && <span className="fcard-keys">
            <Key size="sm" icon="link-external" onClick={() => onApp(app.name, false)} title={`${owner} opens this hub and this file; what you change is in the hub`}>Open in {owner}</Key>
            <Key size="sm" icon="copy" onClick={() => onApp(app.name, true)} title={`A copy in ${owner}'s own folder, outside the hub; the hub's file stays as it is`}>Copy to {owner}</Key>
          </span>}</div>
      )}
      {mediaOf(path) && media(path, "")}
      {t === "csv" && text !== null && <CsvPlot text={text} />}
      {text !== null && (
        <div className="fedit"><Editor key={path} value={text} language={language} session={session} settings={look.settings} appTheme={look.appTheme} ariaLabel={`${nameOf(path)}, ${language.label}`} onChange={onChange} /></div>
      )}
    </div>
  );
}

function AskDialog({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const [v, setV] = useState(ask.value ?? "");
  const go = () => { if (!ask.label || v.trim()) { ask.run(v.trim()); onClose(); } };
  return (
    <Dialog title={ask.title} onClose={onClose} actions={<><Key kind={ask.danger ? "danger" : "primary"} onClick={go}>{ask.ok}</Key><Key onClick={onClose}>Cancel</Key></>}>
      {(ask.note || !ask.label) && <p>{ask.note ?? (ask.danger && ask.ok === "Seal" ? "Its body is frozen and hashed; afterwards it only takes annotations, and corrections go in a new note." : "It goes to the hub's trash, so it can come back.")}</p>}
      {ask.label && <label className="well ask"><input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); go(); } }} aria-label={ask.label} /><em>{ask.label}</em></label>}
    </Dialog>
  );
}
