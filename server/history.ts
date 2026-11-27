// A hub's history (paperboat#16 §4): Git underneath, never shown as Git. The Git folder lives outside the
// hub ($PAPERBOAT_HOME/hubs/<id>/git), so no .git is ever synced with the files; the history travels
// inside the hub as one bundle per machine (.malachite/history/<machine>.bundle), written whole and then
// renamed, so a sync client never sees half a file and no two machines write the same one. Opening the
// hub elsewhere fetches every other machine's bundle and merges it: the files came by the sync, the
// bundles bring their past. People see versions and Restore.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { machine, type Hub } from "./hub.ts";
import { paperboatHome } from "./hubs.ts";

export type Version = { id: string; time: string; author: string; what: string };

export { machine };

export class History {
  readonly gitDir: string;
  readonly ok: boolean;
  private hub: Hub;

  constructor(hub: Hub) {
    this.hub = hub;
    this.gitDir = path.join(paperboatHome(), "hubs", hub.id, "git");
    // no Git: no history, the hub still works; an example has none (it changes in its repository, never here)
    let ok = !hub.example;
    if (ok) try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { ok = false; }
    this.ok = ok;
    if (!ok) return;
    if (!fs.existsSync(path.join(this.gitDir, "HEAD"))) {
      fs.mkdirSync(this.gitDir, { recursive: true });
      this.git("init", "-q", "-b", "main");
    }
    this.excludes();
  }

  private git(...args: string[]): string {
    return execFileSync("git", args, {
      cwd: this.hub.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 30,   // a status of 30 000 new files is past the default 1 MiB
      env: {
        ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.hub.root,
        GIT_AUTHOR_NAME: this.hub.author, GIT_AUTHOR_EMAIL: `${this.hub.author}@${machine()}`,
        GIT_COMMITTER_NAME: "Malachite", GIT_COMMITTER_EMAIL: `malachite@${machine()}`,
      },
    });
  }

  /** What is never versioned: what no file tree shows (dot files and folders: Malachite's own but hub.toml,
   *  an app's own like `.julix/`) and the hub's `ignore`. */
  excludes() {
    const lines = [".*", "!/.malachite/", "/.malachite/*", "!/.malachite/hub.toml", "*.tmp", ...this.hub.conf.ignore.split(/\s+/).filter(Boolean)];
    fs.mkdirSync(path.join(this.gitDir, "info"), { recursive: true });
    fs.writeFileSync(path.join(this.gitDir, "info", "exclude"), lines.join("\n") + "\n");
  }

  private hasHead() { try { this.git("rev-parse", "-q", "--verify", "HEAD"); return true; } catch { return false; } }

  /** A version of whatever changed, or nothing when nothing did. Without words, says what changed. Returns its id. */
  save(what?: string): string | null {
    if (!this.ok) return null;
    this.git("add", "-A");
    // files versioned before they were excluded (an older hub, a new `ignore`) leave the history from here on
    const stale = this.git("ls-files", "-z", "-c", "-i", "--exclude-standard").split("\0").filter(Boolean);
    if (stale.length) this.git("rm", "-q", "--cached", "--", ...stale);
    const status = this.git("status", "--porcelain").split("\n").filter(Boolean);
    if (!status.length) return null;
    this.git("commit", "-q", "--no-verify", "-m", what ?? describe(status));
    return this.git("rev-parse", "--short=12", "HEAD").trim();
  }

  /** The versions, newest first: the whole hub, or one file or folder (then in its own words: Edited, Added…). */
  versions(rel = "", limit = 200): Version[] {
    if (!this.ok || !this.hasHead()) return [];
    const one = rel && rel !== "." && fs.existsSync(path.join(this.hub.root, rel)) && fs.statSync(path.join(this.hub.root, rel)).isFile();
    const out = this.git("log", `-n${limit}`, "--format=%x1e%h%x09%aI%x09%an%x09%s", "--abbrev=12", ...(one ? ["--name-status"] : []), "--", rel || ".");
    const said: Record<string, string> = { A: "Added", M: "Edited", D: "Removed", R: "Moved here", C: "Copied here", T: "Edited" };
    return out.split("\x1e").filter((c) => c.trim()).map((c) => {
      const [head, ...files] = c.split("\n").filter(Boolean);
      const [id, time, author, subject] = head.split("\t");
      const mine = files.find((f) => f.split("\t").pop() === rel);
      const what = !one ? subject : /^Restored /.test(subject) ? `Restored from ${subject.split(" from ").pop()}` : mine && !/^(History from|Before a restore)/.test(subject) ? said[mine[0]] ?? "Edited" : subject;
      return { id, time, author, what };
    });
  }

  /** A file or folder (or the whole hub) as it was in a version; the current one stays a version too. */
  restore(id: string, rel = ""): string | null {
    this.hub.writable();
    if (!this.ok) throw new Error("this hub keeps no versions");
    if (!/^[0-9a-f]{7,40}$/.test(id)) throw new Error(`no version ${id}`);
    this.save("Before a restore");
    this.git("checkout", id, "--", rel || ".");
    const when = this.git("log", "-1", "--format=%aI", id).trim().slice(0, 16).replace("T", " ");
    return this.save(`Restored ${rel || "the hub"} from ${when}`);
  }

  /** This machine's history, packed in one file in the hub (written whole, then renamed). */
  pack() {
    if (!this.ok || !this.hasHead()) return;
    const dir = path.join(this.hub.root, ".malachite", "history"), to = path.join(dir, `${machine()}.bundle`), tmp = `${to}.${process.pid}.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    this.git("bundle", "create", "-q", tmp, "main");
    fs.renameSync(tmp, to);
  }

  /** Every other machine's bundle, merged in: their past joins ours; the files on disk stay as they are. */
  merge(): string[] {
    const dir = path.join(this.hub.root, ".malachite", "history"), joined: string[] = [];
    if (!this.ok || !fs.existsSync(dir)) return joined;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".bundle") && f !== `${machine()}.bundle`)) {
      const m = f.slice(0, -".bundle".length), ref = `refs/machines/${m}/main`;
      try { this.git("fetch", "-q", path.join(dir, f), `+main:${ref}`); } catch { continue; }   // half-synced or damaged: next time
      const theirs = this.git("rev-parse", ref).trim();
      if (this.hasHead()) {
        const ours = this.git("rev-parse", "HEAD").trim();
        if (this.git("merge-base", ours, theirs).trim() === theirs) continue;   // nothing new from them
        this.save("Changes on this machine");
        // keep the files as they are (the sync brought them), with both pasts as parents
        const tree = (this.git("add", "-A"), this.git("write-tree").trim());
        const commit = this.git("commit-tree", tree, "-p", "HEAD", "-p", theirs, "-m", `History from ${m}`).trim();
        this.git("update-ref", "HEAD", commit);
      } else {
        this.git("update-ref", "HEAD", theirs);
        this.git("reset", "-q");   // the index follows; the files stay
        this.save("Changes on this machine");
      }
      joined.push(m);
    }
    return joined;
  }
}

/** What changed, in words, from `git status --porcelain` lines: "Edited notes/a.md", "Added 3 files: …". */
export function describe(status: string[]): string {
  const verb: Record<string, string> = { A: "Added", M: "Edited", D: "Removed", R: "Moved", C: "Copied", T: "Edited" };
  const all = status.map((l) => ({ v: verb[l[0]] ?? "Edited", p: l.slice(3).replace(/^"|"$/g, "") }));
  const own = all.filter((i) => !i.p.startsWith("log/")), items = own.length ? own : all;   // the activity log changes with everything
  if (items.length === 1) return `${items[0].v} ${items[0].p.replace(" -> ", " to ")}`;
  const kinds = new Set(items.map((i) => i.v)), names = items.slice(0, 3).map((i) => i.p.split(" -> ").pop()!.split("/").pop());
  return `${kinds.size === 1 ? items[0].v : "Changed"} ${items.length} files: ${names.join(", ")}${items.length > 3 ? ", …" : ""}`;
}
