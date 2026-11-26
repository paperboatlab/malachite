// The Views page (the mockup's): the hub's notes by their front matter, as Board, List or Timeline. A view
// is a file (views/<name>.toml, client/views.ts); changing a saved one rewrites it, and moving a card to
// another column sets that property on the note.
import { Icon, Key, Panel, Segmented, parseToml, type MenuEntry } from "@paperboatlab/ui";
import { useEffect, useMemo, useState } from "react";
import { MenuChip } from "./MenuChip.tsx";
import { api, type Item } from "./api.ts";
import { FileGlyph } from "./files.tsx";
import { DAY, DEFAULT, NONE, columnsOf, dayOf, first, itemsOf, keysIn, readView, valuesIn, viewPath, viewToml, type Show, type View } from "./views.ts";

type Ask = (title: string, value: string, ok: string, run: (v: string) => void) => void;

const SHOWS: { value: Show; label: string }[] = [{ value: "board", label: "Board" }, { value: "list", label: "List" }, { value: "timeline", label: "Timeline" }];
const isView = (p: string) => /^views\/[^/]+\.toml$/.test(p);
const short = (d: number) => new Date(d).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
const initials = (s: string) => s.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

export function ViewsPage({ items, onOpen, ask, fail }: { items: Item[]; onOpen: (p: string) => void; ask: Ask; fail: (e: Error) => void }) {
  const files = items.filter((i) => isView(i.path));
  const [views, setViews] = useState<View[]>([]);
  // a view file read again when it changes (anyone's edit); a broken one says where and is left out
  const stamp = files.map((f) => `${f.path}@${f.mtime}`).join("|");
  useEffect(() => {
    Promise.all(files.map((f) => api.text(f.path).then((t) => {
      try { return readView(f.path, parseToml(t)); } catch (e) { fail(new Error(`${f.path}: ${(e as Error).message}`)); return null; }
    }))).then((vs) => setViews(vs.filter((v): v is View => !!v)), fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);

  // "" : the first saved view (or All notes when none is); null : the unsaved one
  const [at, setAt] = useState<string | null>(() => new URLSearchParams(location.search).get("view") ?? "");
  const [draft, setDraft] = useState<View>(DEFAULT);
  const view = at === null ? draft : views.find((v) => v.path === at) ?? views[0] ?? draft;

  const update = (patch: Partial<View>) => {
    const next = { ...view, ...patch };
    if (!next.path) return setDraft(next);
    setViews((vs) => vs.map((v) => (v.path === next.path ? next : v)));
    api.save(next.path, viewToml(next)).catch(fail);
  };
  const save = (name: string) => {
    const path = viewPath(name, (p) => files.some((f) => f.path === p)), next = { ...view, name, path };
    api.save(path, viewToml(next)).then(() => { setViews((vs) => [...vs, next]); setAt(path); }, fail);
  };

  const notes = useMemo(() => items.filter((i) => i.type === "md"), [items]);
  const shown = useMemo(() => itemsOf(items, view), [items, view]);
  const keys = useMemo(() => keysIn(notes), [notes]);
  const setFilter = (k: string, v: string) => { const f = { ...view.filter }; if (v) f[k] = v; else delete f[k]; update({ filter: f }); };

  const picker: MenuEntry[] = [
    ...views.map((v): MenuEntry => ({ id: v.path!, label: v.name, checked: v.path === view.path, run: () => setAt(v.path) })),
    ...(views.length ? [] : [{ id: "all", label: DEFAULT.name, checked: !view.path, run: () => setAt(null) } as MenuEntry]),
    "-",
    { id: "new", label: "New view…", run: () => ask("New view", "", "Create", (n) => { setDraft({ ...DEFAULT, name: n }); setAt(null); }) },
  ];

  return (
    <Panel name={view.name} count={`${shown.length} notes · ${view.path ?? "not saved"}`} className="views"
      tools={<>
        {!view.path && <Key size="sm" onClick={() => ask("Save view", view.name === DEFAULT.name && views.length ? "" : view.name, "Save", save)}>Save view</Key>}
        <MenuChip label="Views" menu={picker}>Views<Icon name="chevron-down" size={12} /></MenuChip>
      </>}>
      <div className="vbar">
        {Object.entries(view.filter).map(([k, v]) => (
          <MenuChip key={k} label={`Filter ${k}`} className="chip set" menu={[
            ...valuesIn(notes, k).map((x): MenuEntry => ({ id: x, label: x, checked: x.toLowerCase() === v.toLowerCase(), run: () => setFilter(k, x) })),
            "-", { id: "rm", label: "Remove filter", run: () => setFilter(k, "") },
          ]}><em>{k}</em>{v}<Icon name="chevron-down" size={12} /></MenuChip>
        ))}
        <MenuChip label="Add a filter" className="chip add" menu={keys.filter((k) => !(k in view.filter)).map((k): MenuEntry => ({ id: k, label: k, run: () => { const v = valuesIn(notes, k)[0]; if (v) setFilter(k, v); } }))}>Filter</MenuChip>
        <span className="row-end">
          <MenuChip label="Group by" className="chip" menu={keys.map((k): MenuEntry => ({ id: k, label: k, checked: k === view.group, run: () => update({ group: k, columns: [] }) }))}><em>group by</em>{view.group}<Icon name="chevron-down" size={12} /></MenuChip>
          <Segmented label="Show as" value={view.show} onChange={(show) => update({ show })} options={SHOWS} />
        </span>
      </div>
      {shown.length === 0 ? <p className="empty-state">No note matches this view.</p>
        : view.show === "board" ? <Board items={shown} view={view} onOpen={onOpen} onMove={(p, v) => api.prop(p, view.group, v).catch(fail)} />
        : view.show === "list" ? <List items={shown} onOpen={onOpen} />
        : <Timeline items={shown} view={view} onOpen={onOpen} />}
    </Panel>
  );
}

function Card({ it, onOpen }: { it: Item; onOpen: (p: string) => void }) {
  const sealed = !!it.props.sealed, d = dayOf(it, "created");
  return (
    <div className="ic2" draggable={!sealed} title={sealed ? "Sealed: it stays where it is" : undefined}
      onDragStart={(e) => { e.dataTransfer.setData("text/x-malachite-note", it.path); e.dataTransfer.effectAllowed = "move"; }}
      onClick={() => onOpen(it.path)} onKeyDown={(e) => e.key === "Enter" && onOpen(it.path)} role="button" tabIndex={0}>
      <div className="top"><FileGlyph path={it.path} size={14} />{first(it, "kind") || "note"}{sealed ? " · sealed" : ""}{d !== null && <small>{short(d)}</small>}</div>
      <b>{it.title}</b>
      {(it.tags.length > 0 || first(it, "author")) && <div className="bot">{it.tags.slice(0, 3).map((t) => <span key={t} className="tg">#{t}</span>)}{first(it, "author") && <span className="who" title={first(it, "author")}>{initials(first(it, "author"))}</span>}</div>}
    </div>
  );
}

function Board({ items, view, onOpen, onMove }: { items: Item[]; view: View; onOpen: (p: string) => void; onMove: (p: string, v: string) => void }) {
  const cols = columnsOf(items, view);
  const [over, setOver] = useState<string | null>(null);
  return (
    <div className="board" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(220px, 1fr))` }}>
      {cols.map((c) => {
        const its = items.filter((i) => (first(i, view.group) || NONE) === c);
        return (
          <div key={c} className={`col${over === c ? " over" : ""}`}
            onDragOver={(e) => { if (e.dataTransfer.types.includes("text/x-malachite-note")) { e.preventDefault(); setOver(c); } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}
            onDrop={(e) => { e.preventDefault(); setOver(null); const p = e.dataTransfer.getData("text/x-malachite-note"); const it = items.find((i) => i.path === p); if (it && (first(it, view.group) || NONE) !== c) onMove(p, c === NONE ? "" : c); }}>
            <header>{c}<small>{its.length}</small></header>
            {its.map((i) => <Card key={i.path} it={i} onOpen={onOpen} />)}
          </div>
        );
      })}
    </div>
  );
}

function List({ items, onOpen }: { items: Item[]; onOpen: (p: string) => void }) {
  const rows = [...items].sort((a, b) => first(b, "created").localeCompare(first(a, "created")));
  return (
    <div className="listw"><table className="t">
      <thead><tr><th>title</th><th>kind</th><th>status</th><th>tags</th><th>author</th><th>created</th><th>file</th></tr></thead>
      <tbody>{rows.map((i) => {
        const d = dayOf(i, "created");
        return (
          <tr key={i.path} onClick={() => onOpen(i.path)}>
            <td><FileGlyph path={i.path} size={14} />{i.title}</td><td>{first(i, "kind")}</td>
            <td>{first(i, "status") && <span className="st">{first(i, "status")}</span>}</td>
            <td>{i.tags.map((t) => <span key={t} className="tg">#{t}</span>)}</td>
            <td>{first(i, "author")}</td><td className="v">{d !== null ? short(d) : ""}</td><td className="v muted">{i.path}</td>
          </tr>
        );
      })}</tbody>
    </table></div>
  );
}

function Timeline({ items, view, onOpen }: { items: Item[]; view: View; onOpen: (p: string) => void }) {
  const rows = items.map((i) => ({ i, s: dayOf(i, view.date), e: view.until ? dayOf(i, view.until) : null })).filter((r): r is { i: Item; s: number; e: number | null } => r.s !== null);
  if (!rows.length) return <p className="empty-state">No note here has a {view.date} date.</p>;
  const now = new Date(), today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const lo = Math.min(today, ...rows.map((r) => r.s)) - DAY, hi = Math.max(today, ...rows.map((r) => r.e ?? r.s)) + 2 * DAY;
  const n = Math.round((hi - lo) / DAY), pct = (d: number) => ((d - lo) / (hi - lo)) * 100;
  const days = Array.from({ length: n }, (_, k) => lo + k * DAY);
  const every = n <= 31 ? 1 : n <= 92 ? 7 : 30;   // a label a day, a week or a month, as the span allows
  const lanes = columnsOf(rows.map((r) => r.i), view);
  const lane = { backgroundSize: `calc(100% / ${n}) 100%` };
  return (
    <div className="tl">
      <div className="hd nmh">note</div>
      <div className="hd"><div className="days" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}>
        {days.map((d, k) => { const t = new Date(d), wd = t.getUTCDay(), first1 = t.getUTCDate() === 1 || k === 0;
          return <span key={d} className={`${wd === 0 || wd === 6 ? "we" : ""}${first1 ? " mo" : ""}`}>{k % every === 0 || first1 ? (first1 ? short(d) : t.getUTCDate()) : ""}</span>; })}
      </div></div>
      {lanes.map((g) => [
        <div key={`n${g}`} className="nm grp">{g}</div>, <div key={`l${g}`} className="lane grp" style={lane} />,
        ...rows.filter((r) => (first(r.i, view.group) || NONE) === g).flatMap(({ i, s, e }) => {
          const st = first(i, "status"), cls = /done|closed|sealed/.test(st) ? " done" : /progress/.test(st) ? " act" : "";
          return [
            <div key={`n${i.path}`} className="nm" role="button" tabIndex={0} onClick={() => onOpen(i.path)}><FileGlyph path={i.path} size={14} /><span className="nt">{i.title}</span><small>{short(s)}</small></div>,
            <div key={`l${i.path}`} className="lane" style={lane}>
              {e !== null && e >= s
                ? <span className={`bar2${cls}`} style={{ left: `${pct(s)}%`, width: `${pct(e + DAY) - pct(s)}%` }} onClick={() => onOpen(i.path)}>{st}</span>
                : <i className="ms" style={{ left: `calc(${pct(s + DAY / 2)}% - 7px)` }} title={`${i.title} · ${short(s)}`} onClick={() => onOpen(i.path)} />}
            </div>,
          ];
        }),
      ])}
      <i className="today" style={{ left: `calc(300px + (100% - 300px) * ${pct(today + DAY / 2) / 100})` }} title="today" />
    </div>
  );
}
