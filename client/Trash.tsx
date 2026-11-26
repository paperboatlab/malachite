// The hub's trash (in the hub card, behind its Trash key): what was moved there, newest first, from where,
// by whom and when; Restore puts it back (beside a newcomer that took its name), Delete forever and Empty
// trash ask first. Every action is a line in the activity log.
import { Key, RemoveKey } from "@paperboatlab/ui";
import { useEffect, useState } from "react";
import { api, type Trashed } from "./api.ts";
import { FileGlyph } from "./files.tsx";

export type Confirm = (title: string, note: string, ok: string, run: () => void) => void;

const ago = (iso: string) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(iso).toISOString().slice(0, 10);
};
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export function TrashList({ version, confirm, onRestored, fail }: { version: number; confirm: Confirm; onRestored: (path: string, was: string) => void; fail: (e: unknown) => void }) {
  const [list, setList] = useState<Trashed[] | null>(null);
  const load = () => { api.trashed().then(setList, fail); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [version]);
  if (!list) return null;
  return (
    <div className="trash">
      {list.length === 0 && <p className="empty-state">The trash is empty. A file or folder moved to the trash waits here until you delete it for good.</p>}
      {list.map((t) => (
        <div key={t.id} className="trow">
          <FileGlyph path={t.path} dir={t.kind === "folder"} />
          <span className="tn"><b title={t.path}>{base(t.path)}</b><small>{dirOf(t.path) || "the hub's root"} · {ago(t.time)}{t.actor ? ` · ${t.actor}` : ""}</small></span>
          <span className="tk">
            <Key size="sm" kind="quiet" onClick={() => api.restore(t.id).then((r) => { load(); onRestored(r.path, t.path); }, fail)}>Restore</Key>
            <RemoveKey label="Delete forever" onClick={() => confirm(`Delete ${base(t.path)} forever?`, `${t.path} leaves the hub for good; it can't be restored.`, "Delete forever", () => api.purge(t.id).then(load, fail))} />
          </span>
        </div>
      ))}
      {list.length > 0 && <div className="tfoot"><span>{list.length} in the trash</span>
        <Key size="sm" kind="danger" onClick={() => confirm("Empty the trash?", `${list.length} ${list.length === 1 ? "item leaves" : "items leave"} the hub for good; they can't be restored.`, "Empty trash", () => api.emptyTrash().then(load, fail))}>Empty trash</Key></div>}
    </div>
  );
}
