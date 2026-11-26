// The Graph page and the Links card's local graph: the kit's note graph (Obsidian's) over the hub's links.
// Every node shows its file type (icon and colour, as the file tree); the open note has the ring.
import { NoteGraph, type GraphNode } from "@paperboatlab/ui/graph";
import { fileIconFor } from "@paperboatlab/ui/files";
import { useMemo } from "react";
import type { Item } from "./api.ts";

export type Link = { from: string; to: string };

/** Every resolved link in the hub, as edges. */
export function hubLinks(items: Item[], resolve: (l: string) => string | null): Link[] {
  const out: Link[] = [];
  for (const it of items) for (const l of it.links) { const p = resolve(l); if (p && p !== it.path) out.push({ from: it.path, to: p }); }
  return out;
}

/** The notes one link from `from`, either way, and the links among them: the local graph. */
export function around(from: string, links: Link[]) {
  const seen = new Set([from]);
  for (const l of links) { if (l.from === from) seen.add(l.to); if (l.to === from) seen.add(l.from); }
  return { nodes: [...seen], links: links.filter((l) => seen.has(l.from) && seen.has(l.to)) };
}

/** The whole hub (every note, and every file a note links to), or with `local` the open note's neighbours. */
export function HubGraph({ focus, links, items, local = false, hub, onOpen }: {
  focus: string | null; links: Link[]; items: Item[]; local?: boolean; hub?: string; onOpen: (p: string) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const byPath = new Map(items.map((i) => [i.path, i]));
    const g = local && focus ? around(focus, links)
      : { nodes: [...new Set([...items.filter((i) => i.type === "md").map((i) => i.path), ...links.map((l) => l.to)])], links };
    const nodes: GraphNode[] = g.nodes.map((p) => {
      const it = byPath.get(p), name = p.slice(p.lastIndexOf("/") + 1);
      const { icon, tone } = fileIconFor(name, "file");   // as the file tree draws it
      return { id: p, label: it?.type === "md" ? it.title : name, icon, tone, missing: !it };
    });
    return { nodes, edges: g.links.map((l) => ({ source: l.from, target: l.to })) };
  }, [focus, links, items, local]);
  return <NoteGraph nodes={nodes} links={edges} focus={focus ?? undefined} compact={local} keep={hub} onOpen={onOpen} ariaLabel={local ? "Local graph" : "Hub graph"} />;
}
