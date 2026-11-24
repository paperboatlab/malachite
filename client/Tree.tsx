// The hub tree, and the file menu (REBRAND "File menu"): one right-click menu for files in every app,
// the same groups in the same order; the owning app adds one group under its name; an item that can't
// run stays, greyed, with why.
import { Icon, Menu, type MenuEntry } from "@paperboatlab/ui";
import { useState } from "react";
import type { Entry } from "./api.ts";
import { FileIcon, OWNER, typeOf } from "./files.tsx";

export type FileActions = {
  open: (p: string, side?: boolean) => void;
  newNote: (dir: string) => void;
  newFolder: (dir: string) => void;
  rename: (p: string) => void;
  trash: (p: string) => void;
  seal: (p: string) => void;
  copy: (text: string, what: string) => void;
  reveal: (p: string) => void;
  backlinks: (p: string) => void;
  backlinkCount: (p: string) => number;
  sealed: (p: string) => boolean;
};

export function fileMenu(e: Entry, a: FileActions): MenuEntry[] {
  const dir = e.kind === "dir", t = typeOf(e.path), owner = OWNER[t], name = e.name.replace(/\.md$/, "");
  const items: MenuEntry[] = [];
  if (!dir) {
    items.push({ id: "open", label: "Open", shortcut: "Enter", run: () => a.open(e.path) });
    items.push({ id: "side", label: "Open to the side", shortcut: "Ctrl Enter", run: () => a.open(e.path, true) });
    if (owner) items.push({ id: "in", label: `Open in ${owner}`, icon: "link-external", disabled: true, why: `${owner} isn't installed yet`, run: () => {} });
  } else {
    items.push({ id: "new", label: "New note here", shortcut: "Ctrl N", run: () => a.newNote(e.path) });
    items.push({ id: "folder", label: "New folder here", run: () => a.newFolder(e.path) });
  }
  if (t === "md") {
    const sealed = a.sealed(e.path);
    items.push("-", { note: "Malachite" }, { id: "seal", label: "Seal…", icon: "lock", disabled: sealed, why: "It is sealed", run: () => a.seal(e.path) });
  } else if (owner) {
    items.push("-", { note: owner }, { id: "app", label: owner === "Simplicial" ? "Run the station" : owner === "Julix" ? "Run all cells" : "Simulate", disabled: true, why: `${owner} isn't installed yet`, run: () => {} });
  }
  items.push("-", { id: "rename", label: "Rename…", shortcut: "F2", run: () => a.rename(e.path) });
  items.push("-");
  if (!dir) items.push({ id: "link", label: `Copy link  [[${name}]]`, icon: "copy", run: () => a.copy(`[[${name}]]`, "Link") });
  items.push({ id: "path", label: "Copy path", icon: "copy", run: () => a.copy(e.path, "Path") });
  items.push({ id: "reveal", label: "Reveal in file manager", run: () => a.reveal(e.path) });
  if (!dir) items.push("-", { id: "back", label: `Backlinks  ${a.backlinkCount(e.path)}`, run: () => a.backlinks(e.path) });
  items.push("-", { id: "trash", label: "Move to trash", shortcut: "Del", run: () => a.trash(e.path) });
  return items;
}

export function Tree({ entries, current, open, onToggle, actions }: {
  entries: Entry[]; current: string | null; open: Set<string>; onToggle: (p: string) => void; actions: FileActions;
}) {
  const [menu, setMenu] = useState<{ e: Entry; x: number; y: number } | null>(null);
  const rows: React.ReactNode[] = [];
  const walk = (es: Entry[], d: number) => {
    for (const e of es) {
      const isOpen = open.has(e.path), dir = e.kind === "dir";
      const name = dir || !e.name.includes(".") ? e.name : e.name.slice(0, e.name.lastIndexOf("."));
      const ext = dir || !e.name.includes(".") ? "" : e.name.slice(e.name.lastIndexOf("."));
      rows.push(
        <div key={e.path} role="treeitem" aria-expanded={dir ? isOpen : undefined} aria-selected={e.path === current} tabIndex={-1}
          className={`tr${e.path === current || menu?.e.path === e.path ? " on" : ""}`} style={{ "--d": d } as React.CSSProperties}
          onClick={() => (dir ? onToggle(e.path) : actions.open(e.path))}
          onContextMenu={(ev) => { ev.preventDefault(); setMenu({ e, x: ev.clientX, y: ev.clientY }); }}
          onKeyDown={(ev) => { if (ev.key === "Enter") actions.open(e.path, ev.ctrlKey); if (ev.key === "F2") actions.rename(e.path); if (ev.key === "Delete") actions.trash(e.path); }}>
          {dir ? <span className="cv"><Icon name={isOpen ? "chevron-down" : "chevron-right"} size={12} /></span> : <span className="cv" />}
          <FileIcon path={e.path} dir={dir} open={isOpen} />
          <span className="nm">{name}<span className="x">{ext}</span></span>
          {dir && <small>{count(e)}</small>}
        </div>,
      );
      if (dir && isOpen) walk(e.children ?? [], d + 1);
    }
  };
  walk(entries, 0);
  return (
    <div className="tree" role="tree" aria-label="Hub">
      {rows}
      {menu && (
        <div className="ctx" style={{ left: Math.min(menu.x, innerWidth - 290), top: Math.min(menu.y, innerHeight - 440) }}>
          <div className="mh"><FileIcon path={menu.e.path} dir={menu.e.kind === "dir"} size={14} />{menu.e.name}</div>
          <Menu label={`${menu.e.name}: actions`} items={fileMenu(menu.e, actions)} onClose={() => setMenu(null)} />
        </div>
      )}
    </div>
  );
}

const count = (e: Entry): number => (e.children ?? []).reduce((n, c) => n + (c.kind === "dir" ? count(c) : 1), 0);
