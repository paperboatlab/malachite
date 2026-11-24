// File icons (brand.html §11): Codicons for common files, our own formats in their app's mark, coloured by
// type. ponytail: lives here until a second app needs it, then moves to @paperboatlab/ui as FileIcon.
import { Icon, type IconName } from "@paperboatlab/ui";

/** Which app owns a type, for "Open in" and embeds. None is installed on the new platform yet. */
export const OWNER: Record<string, string> = { pst: "Simplicial", psf: "Simplicial", mo: "Articula", fmu: "Articula", jl: "Julix", mx: "Julix" };
export const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp"]);
export const TEXT = new Set(["md", "txt", "toml", "json", "jsonl", "csv", "jl", "py", "mo", "yaml", "yml", "log", "tsv"]);

const BY_TYPE: Record<string, [IconName, string]> = {
  md: ["markdown", "steel"], mo: ["file-code", "articula"], jl: ["file-code", "julix"], py: ["file-code", "slate"], mx: ["notebook", "julix"],
  fmu: ["file-zip", "articula"], zip: ["file-zip", "slate"], csv: ["table", "green"], tsv: ["table", "green"], json: ["json", "amber"], jsonl: ["json", "amber"],
  toml: ["settings-gear", "slate"], png: ["file-media", "rose"], jpg: ["file-media", "rose"], jpeg: ["file-media", "rose"], gif: ["file-media", "rose"],
  svg: ["file-media", "rose"], webp: ["file-media", "rose"],
};
const MARKS: Record<string, string> = {   // our formats' marks: the letter's creases on the sheet (logogen system.jl mark_body)
  simplicial: "<rect x='2.5' y='2.5' width='11' height='11' rx='1'/><path d='M2.5 6.85L11.3 2.5'/><path d='M2.5 6.85L13.5 8.28'/><path d='M13.5 8.53L4.15 13.5'/>",
};

export const typeOf = (p: string) => (p.includes(".") ? p.slice(p.lastIndexOf(".") + 1).toLowerCase() : "");

export function FileIcon({ path, dir, open, size = 16 }: { path: string; dir?: boolean; open?: boolean; size?: number }) {
  if (dir) return <span className="fc-folder fi"><Icon name={open ? "folder-opened" : "folder"} size={size} /></span>;
  const t = typeOf(path);
  if (t === "pst" || t === "psf") {
    return <svg className="fi fc-simplicial" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="square" aria-hidden="true" dangerouslySetInnerHTML={{ __html: MARKS.simplicial }} />;
  }
  const [icon, colour] = BY_TYPE[t] ?? ["file", "slate"];
  return <span className={`fi fc-${colour}`}><Icon name={icon} size={size} /></span>;
}
