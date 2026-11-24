// Trace (the rail's page) and the Links card's local graph: what a note came from and what came of it,
// on React Flow, laid out left to right by the kit's layoutGraph (what links in on the left, what it
// links to on the right). One component; the local graph is depth 1, small and still.
import { layoutGraph } from "@paperboatlab/ui/canvas";
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { useMemo } from "react";
import type { Item } from "./api.ts";
import { FileGlyph } from "./files.tsx";

type Data = { path: string; title: string; meta: string; me: boolean; small: boolean };
export type Link = { from: string; to: string };

/** Every resolved link in the hub, as edges. */
export function hubLinks(items: Item[], resolve: (l: string) => string | null): Link[] {
  const out: Link[] = [];
  for (const it of items) for (const l of it.links) { const p = resolve(l); if (p && p !== it.path) out.push({ from: it.path, to: p }); }
  return out;
}

/** The nodes within `depth` links of `from`, both ways, the links between them, and the link that first
 *  reached each node: those alone shape the layout, so what links in lands left of `from`, what it links
 *  to right of it, and a link back (a cycle) can't fold the lineage into one line. */
export function around(from: string, links: Link[], depth: number) {
  const seen = new Map<string, number>([[from, 0]]);
  const shape: Link[] = [];
  for (let d = 0; d < depth; d++) {
    for (const l of links) {
      if (seen.get(l.from) === d && !seen.has(l.to)) { seen.set(l.to, d + 1); shape.push(l); }
      if (seen.get(l.to) === d && !seen.has(l.from)) { seen.set(l.from, d + 1); shape.push(l); }
    }
  }
  const unique = new Map(links.filter((l) => seen.has(l.from) && seen.has(l.to)).map((l) => [`${l.from}>${l.to}`, l]));
  return { nodes: [...seen.keys()], links: [...unique.values()], shape };
}

function FileNode({ data }: NodeProps<Node<Data>>) {
  return (
    <div className={`tnode${data.me ? " me" : ""}${data.small ? " small" : ""}`} title={data.path}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="th"><FileGlyph path={data.path} size={data.small ? 12 : 14} /><b>{data.title}</b></span>
      {!data.small && data.meta && <small>{data.meta}</small>}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
const TYPES = { file: FileNode };

export function TraceGraph({ from, links, items, depth, small = false, onOpen }: {
  from: string; links: Link[]; items: Item[]; depth: number; small?: boolean; onOpen: (p: string) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const g = around(from, links, depth);
    const byPath = new Map(items.map((i) => [i.path, i]));
    const [w, h] = small ? [96, 24] : [190, 52];
    const at = layoutGraph(g.nodes.map((id) => ({ id, width: w, height: h })), g.shape.map((l) => ({ source: l.from, target: l.to })),
      { columnGap: small ? 36 : 70, rowGap: small ? 8 : 22 });
    const nodes: Node<Data>[] = g.nodes.map((p) => {
      const it = byPath.get(p), kind = it?.props.kind, status = it?.props.status;
      return {
        id: p, type: "file", position: at.get(p) ?? { x: 0, y: 0 }, draggable: !small,
        data: { path: p, title: it?.type === "md" ? it.title : p.slice(p.lastIndexOf("/") + 1), meta: [kind, status].filter(Boolean).join(" · ") || (it?.type ?? ""), me: p === from, small },
      };
    });
    // a link that runs right to left (back to something already placed, a cycle) is drawn quieter
    const x = (p: string) => at.get(p)?.x ?? 0;
    const edges: Edge[] = g.links.map((l) => ({
      id: `${l.from}>${l.to}`, source: l.from, target: l.to, type: x(l.to) > x(l.from) ? "smoothstep" : "default",
      className: [l.from === from || l.to === from ? "near" : "", x(l.to) <= x(l.from) ? "back" : ""].join(" "),
    }));
    return { nodes, edges };
  }, [from, links, items, depth, small]);
  return (
    <div className={`trace${small ? " small" : ""}`}>
      {/* a new set of nodes (the index arrived, the depth changed) is a new view: it fits again */}
      <ReactFlow key={nodes.map((n) => n.id).join("|")} nodes={nodes} edges={edges} nodeTypes={TYPES} fitView fitViewOptions={{ padding: small ? 0.08 : 0.15 }} proOptions={{ hideAttribution: true }}
        nodesConnectable={false} elementsSelectable={!small} panOnDrag={!small} zoomOnScroll={!small} zoomOnPinch={!small} zoomOnDoubleClick={false} preventScrolling={!small}
        onNodeClick={(_, n) => n.id !== from && onOpen(n.id)} minZoom={0.2}>
        <Background gap={small ? 12 : 16} size={1} />
        {!small && <Controls showInteractive={false} position="bottom-left" />}
        {!small && <MiniMap pannable zoomable position="bottom-right" />}
      </ReactFlow>
    </div>
  );
}
