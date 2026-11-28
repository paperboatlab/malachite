// Cells run in sessions: one session lease per language for the hub (paperboat-runtime/0 session mode:
// a live namespace shared by the hub's notes, as a Jupyter kernel is). Malachite runs no code itself
// (pb#415 §9): it asks paperboatd for the lease and speaks the protocol. Outputs are kept beside the
// note in `.malachite/out/<note id>/<cell hash>.json` (decision 16), with the runtime that made them; an
// example's in its state folder outside it (Hub.state). A container mounts the project read-only (paperboatd's
// default policy: no `writable_project`). An example's runtimes are asked for with `readonly` (pb#91), which
// paperboatd keeps on every backend (`:ro`, Landlock natively on Linux, else it refuses the backend), so a cell
// can't write into it however it names the path. A Julia session starts once the hub's Manifest is installed in
// its deps volume (packages.ts).
import fs from "node:fs";
import path from "node:path";
import { Control, type Lease } from "./control.ts";
import { parse, type Cell, type Lang, type Note } from "./note.ts";
import { depsVolume, instantiate, missing, readonly } from "./packages.ts";
import { Runtime, RuntimeError, type ErrorInfo } from "./runtime.ts";
import type { Hub } from "./hub.ts";

export type Output =
  | { type: "stream"; name: string; text: string }
  | { type: "display"; data: Record<string, string> }
  | { type: "result"; data: Record<string, string> }
  | { type: "error"; error: { type?: string; message: string; traceback?: string } };
export type Run = {
  note: string; hash: string; lang: Lang; state: "queued" | "running" | "done" | "failed" | "skipped";
  ran?: string; ms?: number; outputs: Output[];
  runtime?: { name: string; version: string; backend: string; digest?: string; verified?: string };
};
/** `ended`: why it was stopped (a restart, an interrupt that didn't stop the cell, the hub closing), which the
 *  cell it ends says instead of "the runtime ended". */
type Session = { lease: Lease; rt: Runtime; cwd?: string; ended?: string };
/** A session as it starts and runs: its lease is known before the runtime answers, and the start can be
 *  stopped (an interrupt, a restart, the runtime ending) instead of waiting out the connect. `notice`: what
 *  the first cell says before its output (the hub's packages couldn't be installed). */
type Entry = { ready: Promise<Session>; abort: AbortController; lease?: string; session?: Session; notice?: string };

/** Cells run in their note's folder, as Jupyter runs a notebook's (the daemon sets PAPERBOAT_PROJECT). */
function chdir(lang: Lang, dir: string): string {
  const s = JSON.stringify(dir);
  return lang === "julia" ? `cd(joinpath(ENV["PAPERBOAT_PROJECT"], ${s.replaceAll("$", "\\$")})); nothing` : `import os as _pb_os; _pb_os.chdir(_pb_os.path.join(_pb_os.environ["PAPERBOAT_PROJECT"], ${s})); del _pb_os`;
}

const NAME: Record<Lang, string> = { julia: "Julia", python: "Python" };
/** A figure the app draws itself (paperboat/docs/runtime.md "Figures": JulixPlot's) comes with no picture.
 *  Malachite draws pictures only, so it asks the session for the figure's SVG, which the runtime keeps as `ans`. */
const FIGURE = "application/vnd.paperboat.figure+json";
const FIGURE_SVG = 'let x = ans; showable(MIME"image/svg+xml"(), x) && print(sprint(show, MIME"image/svg+xml"(), x)) end; nothing';
const INTERRUPT_GRACE_MS = 3000;   // after an interrupt with no reply, the session restarts (docs/runtime.md)
const safe = (id: string) => id.replace(/[^\w-]+/g, "_");
export class NoSession extends Error {}

export class Sessions {
  private sessions = new Map<Lang, Entry>();
  private queues = new Map<Lang, Promise<unknown>>();
  readonly running = new Map<Lang, Run>();
  private where = new WeakMap<Run, { path: string; title: string }>();   // for the peek, never saved with the run
  /** The hub closed (`stop`): no session starts for it again, and its queued cells don't run. */
  private closed = false;

  private hub: Hub;
  private control: Control;
  private emit: (e: Record<string, unknown>) => void;

  constructor(hub: Hub, control: Control, emit: (e: Record<string, unknown>) => void) {
    this.hub = hub;
    this.control = control;
    this.emit = emit;
    control.onEvent = (e) => {
      this.emit({ type: "runtime", event: e });
      // a first start pulls the runtime's image inside acquire (minutes for Julia): the page's toast says so
      const lang = String(e.runtime ?? "").split("@")[0] as Lang, starting = this.sessions.get(lang);
      if (starting && !starting.session && (e.event === "runtime.pulling" || e.event === "runtime.pulled")) {
        this.emit({ type: "session", lang, state: "starting", detail: e.event === "runtime.pulling" ? `Downloading the ${NAME[lang]} runtime: the first start takes a few minutes` : `Starting ${NAME[lang]}` });
      }
      if (e.event === "runtime.exited" || e.event === "runtime.failed") {
        for (const [lang, x] of this.sessions) if (x.lease && (x.lease === e.lease || x.lease === (e as any).id)) this.drop(lang);
      }
    };
    control.onClose = () => { for (const lang of [...this.sessions.keys()]) this.drop(lang); };
  }

  private session(lang: Lang): Promise<Session> {
    if (this.closed) return Promise.reject(new Error("the hub closed"));
    let x = this.sessions.get(lang);
    if (!x) {
      this.emit({ type: "session", lang, state: "starting" });
      const entry = x = { abort: new AbortController() } as Entry;
      entry.ready = this.start(lang, entry);
      entry.ready.catch((e) => {
        if (this.sessions.get(lang) !== entry) return;   // stopped on purpose: drop said so
        this.sessions.delete(lang);
        this.emit({ type: "session", lang, state: "failed", error: String(e?.message ?? e) });
      });
      this.sessions.set(lang, entry);
    }
    return x.ready;
  }

  private async start(lang: Lang, entry: Entry): Promise<Session> {
    if (lang === "julia") await this.packages(entry);
    entry.abort.signal.throwIfAborted();
    const lease = await this.control.call<Lease>("acquire", { runtime: lang, mode: "session", project: this.hub.root, ...readonly(this.hub), owner: `malachite:${this.hub.name}` });
    entry.lease = lease.id;
    try {
      if (lease.state === "failed") throw new Error(lease.error ?? `${lang} failed to start`);
      entry.abort.signal.throwIfAborted();
      const rt = await Runtime.connect(path.join(lease.ipc, "runtime.sock"), 120_000, entry.abort.signal);
      rt.onClose = () => { if (this.sessions.get(lang) === entry) this.drop(lang); };
      entry.session = { lease, rt };
      this.emit({ type: "session", lang, state: "running" });
      return entry.session;
    } catch (e) {
      this.control.call("release", { lease: lease.id }).catch(() => {});
      throw e;
    }
  }

  /** The hub's Manifest installed in its deps volume first, when it lacks some of it (julix#47). A failure
   *  (no network) doesn't keep the session from starting: the first cell says why, and `using` says what. */
  private async packages(entry: Entry) {
    try {
      const need = missing(this.hub.root, await depsVolume(this.control, this.hub.root));
      if (!need.length) return;
      const what = `Installing ${need.length === 1 ? need[0] : `${need.length} packages`} from the hub's Manifest.toml`;
      this.emit({ type: "session", lang: "julia", state: "starting", detail: what });
      await instantiate(this.control, this.hub, `malachite:${this.hub.name}:packages`, entry.abort.signal,
        (line) => this.emit({ type: "session", lang: "julia", state: "starting", detail: `${what}: ${line}` }));
    } catch (e) {
      entry.abort.signal.throwIfAborted();
      entry.notice = `Malachite: the hub's Julia packages couldn't be installed, so \`using\` may fail. ${String((e as Error).message ?? e)}\n`;
    }
  }

  /** Ends the session; `why` is what its running cell says. */
  private drop(lang: Lang, why?: string) {
    const x = this.sessions.get(lang);
    if (!x) return;
    this.sessions.delete(lang);
    if (x.session && why) x.session.ended = why;
    x.abort.abort(new Error(`the ${lang} session was stopped before it started`));
    x.ready.then((s) => { s.rt.close(); this.control.call("release", { lease: s.lease.id }).catch(() => {}); }, () => {});
    this.emit({ type: "session", lang, state: "stopped" });
  }

  /** `.malachite/out/<note id>/` in the hub; an example's outside it (`Hub.state`), so a run leaves it as it is. */
  outDir(noteId: string) { return path.join(this.hub.state, "out", safe(noteId)); }

  /** The saved outputs of a note's cells, by cell hash. */
  outputs(noteId: string): Record<string, Run> {
    const dir = this.outDir(noteId), out: Record<string, Run> = {};
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try { out[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { /* a damaged output is simply not shown */ }
    }
    for (const r of this.running.values()) if (r.note === noteId) out[r.hash] = r;
    return out;
  }

  /** Runs the cell of `note` whose hash is `hash`; cells of one language run in order. */
  run(rel: string, hash: string): Run {
    const n = parse(this.hub.read(rel), path.basename(rel, ".md"));
    const cell = n.cells.find((c) => c.hash === hash);
    if (!cell) throw new Error("that cell changed or is gone: run it again");
    return this.queue(rel, n, cell).run;
  }

  /** Runs every cell of `note` in order, whatever their language (a Python cell may read what a Julia cell
   *  wrote); once one fails or is stopped, the rest are skipped and keep the outputs they had. */
  runAll(rel: string): Run[] {
    const n = parse(this.hub.read(rel), path.basename(rel, ".md"));
    let after: Promise<Run> | undefined;
    return n.cells.map((cell) => { const q = this.queue(rel, n, cell, after); after = q.done; return q.run; });
  }

  /** Queues a cell behind its language's queue and `after` (the cell before it in a Run all). */
  private queue(rel: string, n: Note, cell: Cell, after?: Promise<Run>): { run: Run; done: Promise<Run> } {
    const noteId = typeof n.props.id === "string" ? n.props.id : rel, hash = cell.hash;
    const run: Run = { note: noteId, hash, lang: cell.lang, state: "queued", outputs: [] };
    this.where.set(run, { path: rel, title: n.title });
    // nothing is said once the hub closed: the page shows another hub, which may have a note at the same path
    const send = () => { if (!this.closed) this.emit({ type: "cell", path: rel, run }); };
    send();
    const prev = this.queues.get(cell.lang) ?? Promise.resolve();
    const next = Promise.all([prev, after]).then(async ([, before]) => {
      if (this.closed) { run.state = "skipped"; return; }   // the hub closed before its turn: it never runs
      if (before && before.state !== "done") {
        const saved = this.saved(noteId, hash);
        Object.assign(run, { state: "skipped", outputs: saved?.outputs ?? [], ran: saved?.ran, ms: saved?.ms, runtime: saved?.runtime });
        return send();
      }
      run.state = "running";
      run.ran = new Date().toISOString();
      this.running.set(cell.lang, run);
      send();
      const t0 = Date.now();
      let s: Session | undefined;
      try {
        s = await this.session(cell.lang);
        const x = this.sessions.get(cell.lang);
        if (x?.notice) { run.outputs.push({ type: "stream", name: "stderr", text: x.notice }); x.notice = undefined; }
        const dir = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);
        if (s.cwd !== dir) { await s.rt.request("eval", { code: chdir(cell.lang, dir), cell: "malachite: the note's folder" }); s.cwd = dir; }
        run.runtime = { name: s.rt.hello!.runtime.name, version: s.rt.hello!.runtime.version, backend: s.lease.backend, digest: s.lease.digest, verified: s.lease.verified };
        const result = await s.rt.request<{ data: Record<string, string> | null }>("eval", { code: cell.code, cell: `${rel}:${cell.line + 1}` }, (note) => {
          if (note.type === "stream") {
            const last = run.outputs.at(-1);
            if (last?.type === "stream" && last.name === note.name) last.text += note.text;
            else run.outputs.push({ type: "stream", name: note.name, text: note.text });
          } else if (note.type === "display") run.outputs.push({ type: "display", data: note.data });
          send();
        });
        if (result?.data) run.outputs.push({ type: "result", data: await this.picture(s, result.data) });
        run.state = "done";
      } catch (e) {
        run.outputs.push({ type: "error", error: await this.why(cell.lang, e, s) });
        run.state = "failed";
      }
      run.ms = Date.now() - t0;
      this.running.delete(cell.lang);
      fs.mkdirSync(this.outDir(noteId), { recursive: true });
      fs.writeFileSync(path.join(this.outDir(noteId), `${hash}.json`), JSON.stringify(run));
      this.hub.log("cell.ran", rel, { lang: cell.lang, hash, ok: run.state === "done", ms: run.ms });
      send();
    }).then(() => run);
    this.queues.set(cell.lang, next.catch(() => {}));
    return { run, done: next };
  }

  /** A JulixPlot figure's value with its SVG added (its scene stays, for an app that draws it); any other as it is. */
  private async picture(s: Session, data: Record<string, string>): Promise<Record<string, string>> {
    if (!data[FIGURE] || data["image/svg+xml"] || data["image/png"]) return data;
    let svg = "";
    try { await s.rt.request("eval", { code: FIGURE_SVG, cell: "malachite: the figure as a picture" }, (n) => { if (n.type === "stream" && n.name === "stdout") svg += n.text; }); }
    catch { return data; }   // the text stands in
    return svg.trimStart().startsWith("<") ? { ...data, "image/svg+xml": svg } : data;
  }

  /** A cell's saved run, or undefined. */
  private saved(noteId: string, hash: string): Run | undefined {
    try { return JSON.parse(fs.readFileSync(path.join(this.outDir(noteId), `${hash}.json`), "utf8")); } catch { return undefined; }
  }

  /** What a failed cell says: the runtime's error, why its session was stopped (a restart, an interrupt that
   *  didn't stop it, the hub closing), or that the runtime ended on its own, with the end of its log. */
  private async why(lang: Lang, e: unknown, s?: Session): Promise<ErrorInfo> {
    if (!(e instanceof RuntimeError)) return { type: "malachite", message: String((e as Error).message ?? e) };
    if (e.error.type !== "closed") return e.error;
    if (s?.ended) return { message: s.ended };
    const log = s ? await this.control.call<{ text: string }>("logs", { lease: s.lease.id, tail: 20 }).then((r) => r.text.trim(), () => "") : "";
    return { message: `The ${NAME[lang]} session ended while the cell ran: its variables are gone, and the next cell starts a new one.`, ...(log && { traceback: log }) };
  }

  /** Stops the running cell: SIGINT through the daemon; a runtime that doesn't answer soon restarts. A cell
   *  whose session is still starting stops the start. Answers at once: it never waits on the runtime. */
  interrupt(lang: Lang) {
    const x = this.sessions.get(lang), run = this.running.get(lang);
    if (!x || !run) return { interrupted: false };
    const s = x.session;
    if (!s) { this.drop(lang); return { interrupted: true }; }
    setTimeout(() => {
      if (this.running.get(lang) === run && this.sessions.get(lang) === x) this.drop(lang, `The cell didn't stop within ${INTERRUPT_GRACE_MS / 1000} s, so the ${NAME[lang]} session restarted: its variables are gone.`);
    }, INTERRUPT_GRACE_MS);
    this.control.call("interrupt", { lease: s.lease.id }).catch(() => s.rt.request("interrupt").catch(() => {}));
    return { interrupted: true };
  }

  /** The editor's questions to a running session (paperboat-runtime/0 `lint`, `complete`): answered at
   *  once even while a cell runs; never starts a session just to ask. */
  async ask(lang: Lang, op: string, args: Record<string, unknown>) {
    if (op !== "lint" && op !== "complete") throw new Error(`${op} is not asked from the editor`);
    const x = this.sessions.get(lang);
    if (!x) throw new NoSession(`no ${lang} session runs`);
    return (await x.ready).rt.request(op, args);
  }

  /** Ends every session (the hub closes) and keeps any from starting again: a cell still queued never runs.
   *  The daemon connection stays for the next hub. */
  stop() {
    for (const lang of [...this.sessions.keys()]) this.drop(lang, "The hub closed while the cell ran.");
    this.closed = true;
  }

  /** Ends every session and the daemon connection (which releases the leases). */
  close() { this.stop(); this.control.close(); }

  /** A fresh session: the namespace is lost; the next cell starts a new one. */
  restart(lang: Lang) { this.drop(lang, `The ${NAME[lang]} session restarted while the cell ran.`); return {}; }

  /** The runtimes key's peek: this hub's sessions with their stats, and what could start. */
  async peek() {
    const leases = await this.control.call<Lease[]>("ps");
    const mine = leases.filter((l) => l.owner === `malachite:${this.hub.name}` && l.project === this.hub.root);
    const sessions = await Promise.all(mine.map(async (l) => {
      const lang = l.runtime.split("@")[0] as Lang;   // the lease names its runtime "julia@1.11.9"
      return {
        ...l, lang,
        stats: await this.control.call("stats", { lease: l.id }).then((r: any) => r.stats, () => null),
        running: [...this.running.values()].filter((r) => r.lang === lang && r.state === "running").map((r) => ({ note: r.note, ...this.where.get(r), hash: r.hash, since: r.ran })),
      };
    }));
    const list = await this.control.call<{ runtimes: { name: string; version: string; modes: string[] }[] }>("runtimes.list");
    return { sessions, runtimes: list.runtimes.filter((r) => r.modes.includes("session")).map((r) => ({ name: r.name, version: r.version })) };
  }
}
