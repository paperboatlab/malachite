// Markdown to HTML for the Read view: `marked`, plus wikilinks (`[[note]]`, `[[note|text]]`), embeds
// (`![[file]]`) and math (`$…$`, `$$…$$`, the kit's KaTeX, as Live draws it). A note is someone's text, maybe from a cloned hub: raw HTML is shown as text and a
// link may only go to http(s), mailto or inside the hub.
import { INLINE_MATH, mathHtml } from "@paperboatlab/ui";
import { Marked, type Tokens } from "marked";
import { OWNER, mediaOf, typeOf } from "./files.tsx";

export type Resolve = (link: string) => string | null;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const raw = (p: string) => `/api/raw?path=${encodeURIComponent(p)}`;
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
/** Where a picture, a video or a sound goes: ReadView draws the kit's player or the picture into it. */
const slot = (p: string, alt: string) => `<span class="media-slot" data-path="${esc(p)}" data-alt="${esc(alt)}"></span>`;
/** a/b/../c → a/c */
const normal = (p: string) => p.split("/").reduce<string[]>((o, s) => (s === ".." ? o.slice(0, -1) : s && s !== "." ? [...o, s] : o), []).join("/");

type Wiki = Tokens.Generic & { embed: boolean; target: string; label: string };
type Math = Tokens.Generic & { tex: string };
const INLINE = new RegExp(`^${INLINE_MATH.source}`);

export function renderer(resolve: Resolve, here: string) {
  const dir = here.includes("/") ? here.slice(0, here.lastIndexOf("/") + 1) : "";
  const m = new Marked({ gfm: true });
  m.use({
    extensions: [{
      name: "mathBlock",
      level: "block",
      start: (src: string) => src.match(/^\$\$/m)?.index,
      tokenizer(src: string) {
        const x = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
        if (x) return { type: "mathBlock", raw: x[0], tex: x[1].trim() } as Math;
      },
      renderer: (t) => `<div class="math-block">${mathHtml((t as Math).tex, true)}</div>`,
    }, {
      name: "math",
      level: "inline",
      start: (src: string) => src.match(/(?<![\\$])\$(?![\s$])/)?.index,
      tokenizer(src: string) {
        const x = INLINE.exec(src);
        if (x) return { type: "math", raw: x[0], tex: x[1] } as Math;
      },
      renderer: (t) => mathHtml((t as Math).tex),
    }, {
      name: "wiki",
      level: "inline",
      start: (src: string) => src.match(/!?\[\[/)?.index,
      tokenizer(src: string) {
        const x = /^(!?)\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/.exec(src);
        if (x) return { type: "wiki", raw: x[0], embed: x[1] === "!", target: x[2].trim(), label: (x[4] ?? x[2]).trim() } as Wiki;
      },
      renderer(t) {
        const { embed, target, label } = t as Wiki;
        const p = resolve(target);
        if (!p) return `<a class="wl miss" data-wl="${esc(target)}" title="Not written yet: click to create">${esc(label)}</a>`;
        const type = typeOf(p);
        if (embed && mediaOf(p)) return slot(p, label === target ? "" : label);   // a picture, a video, a sound: drawn by the page
        if (embed && type !== "md") {
          const owner = OWNER[type];
          return `<span class="embed-card" data-wl="${esc(p)}"><b>${esc(base(p))}</b><small>${owner ? `drawn by ${owner} once it is installed; until then its name and type` : "a file in the hub"}</small></span>`;
        }
        return `<a class="wl${embed ? " embed-link" : ""}" data-wl="${esc(p)}">${esc(label)}</a>`;
      },
    }],
    renderer: {
      html: (t: Tokens.HTML | Tokens.Tag) => esc(t.text),
      link(t: Tokens.Link) {
        const text = this.parser.parseInline(t.tokens);
        if (/^(https?:|mailto:)/i.test(t.href)) return `<a href="${esc(t.href)}" target="_blank" rel="noreferrer">${text}</a>`;
        if (/^[a-z][\w+.-]*:/i.test(t.href)) return text;   // javascript:, file:, …: not a link here
        return `<a class="wl" data-wl="${esc(decodeURI(dir + t.href))}">${text}</a>`;
      },
      image(t: Tokens.Image) {
        if (/^https?:/i.test(t.href)) return `<img src="${esc(t.href)}" alt="${esc(t.text)}">`;
        if (/^[a-z][\w+.-]*:/i.test(t.href)) return esc(t.text);
        const p = normal(decodeURI(dir + t.href));
        return mediaOf(p) ? slot(p, t.text) : `<img src="${raw(p)}" alt="${esc(t.text)}">`;
      },
    },
  });
  return (md: string) => m.parse(md, { async: false }) as string;
}
