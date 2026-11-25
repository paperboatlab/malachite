// The file menu (REBRAND "File menu"), given to the kit's FileTree: the same groups in the same order in
// every app; Malachite's own group under its name; the owner's group for the other apps' files, greyed
// with why while they aren't installed. No entry: the tree's empty space (new things at the root).
import type { MenuEntry } from "@paperboatlab/ui";
import type { FileEntry } from "@paperboatlab/ui/files";
import { OWNER, typeOf } from "./files.tsx";

export type FileActions = {
  open: (p: string, side?: boolean) => void;
  newNote: (dir: string) => void;
  newFolder: (dir: string) => void;
  rename: (p: string) => void;
  trash: (p: string) => void;
  seal: (p: string) => void;
  copy: (text: string, what: string) => void;
  reveal: (p: string) => void;
  graph: (p: string) => void;
  backlinks: (p: string) => void;
  backlinkCount: (p: string) => number;
  sealed: (p: string) => boolean;
};

/** `tab`: for a tab's menu, which leaves out the Open group (the tab is open). */
export function fileMenu(e: FileEntry | undefined, a: FileActions, tab = false): MenuEntry[] {
  if (!e) return [{ id: "new", label: "New note", shortcut: "Ctrl N", icon: "new-file", run: () => a.newNote("") }, { id: "folder", label: "New folder", icon: "new-folder", run: () => a.newFolder("") }];
  const dir = e.kind === "folder", t = typeOf(e.path), owner = OWNER[t], name = e.name.replace(/\.md$/, "");
  const items: MenuEntry[] = [];
  if (!dir && !tab) {
    items.push({ id: "open", label: "Open", shortcut: "Enter", run: () => a.open(e.path) });
    items.push({ id: "side", label: "Open to the side", shortcut: "Ctrl Enter", run: () => a.open(e.path, true) });
    if (owner) items.push({ id: "in", label: `Open in ${owner}`, icon: "link-external", disabled: true, why: `${owner} isn't installed yet`, run: () => {} });
  } else if (dir) {
    items.push({ id: "new", label: "New note here", shortcut: "Ctrl N", run: () => a.newNote(e.path) });
    items.push({ id: "folder", label: "New folder here", run: () => a.newFolder(e.path) });
  }
  if (t === "md") {
    items.push("-", { group: "Malachite" }, { id: "seal", label: "Seal…", icon: "lock", disabled: a.sealed(e.path), why: "It is sealed", run: () => a.seal(e.path) });
  } else if (owner) {
    items.push("-", { group: owner }, { id: "app", label: owner === "Simplicial" ? "Run the station" : owner === "Julix" ? "Run all cells" : "Simulate", disabled: true, why: `${owner} isn't installed yet`, run: () => {} });
  }
  items.push("-", { id: "rename", label: "Rename…", shortcut: "F2", run: () => a.rename(e.path) });
  items.push("-");
  if (!dir) items.push({ id: "link", label: `Copy link  [[${name}]]`, icon: "copy", run: () => a.copy(`[[${name}]]`, "Link") });
  items.push({ id: "path", label: "Copy path", icon: "copy", run: () => a.copy(e.path, "Path") });
  items.push({ id: "reveal", label: "Reveal in file manager", run: () => a.reveal(e.path) });
  if (!dir) items.push("-", { id: "graph", label: "Show in graph", run: () => a.graph(e.path) }, { id: "back", label: `Backlinks  ${a.backlinkCount(e.path)}`, run: () => a.backlinks(e.path) });
  items.push("-", { id: "trash", label: "Move to trash", shortcut: "Del", run: () => a.trash(e.path) });
  return items[0] === "-" ? items.slice(1) : items;
}
