// What the page knows about file types: their icon (the kit's, brand.html §11), the app that owns them,
// and which ones show as images or text.
import { Icon } from "@paperboatlab/ui";
import { fileIconFor } from "@paperboatlab/ui/files";

/** Which app owns a type, for "Open in" and embeds. None is installed on the new platform yet. */
export const OWNER: Record<string, string> = { pst: "Simplicial", psf: "Simplicial", mo: "Articula", fmu: "Articula", jl: "Julix", mx: "Julix" };
export const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp"]);
export const TEXT = new Set(["md", "txt", "toml", "json", "jsonl", "csv", "tsv", "jl", "py", "mo", "yaml", "yml", "log"]);

export const typeOf = (p: string) => { const n = p.slice(p.lastIndexOf("/") + 1); return n.includes(".") ? n.slice(n.lastIndexOf(".") + 1).toLowerCase() : ""; };

/** A file's or folder's icon in its type's colour. */
export function FileGlyph({ path, dir, open, size = 16 }: { path: string; dir?: boolean; open?: boolean; size?: number }) {
  const { icon, tone } = fileIconFor(path.slice(path.lastIndexOf("/") + 1), dir ? "folder" : "file", open);
  return <span className="fi" style={{ color: `var(--file-${tone})` }}><Icon name={icon} size={size} /></span>;
}
