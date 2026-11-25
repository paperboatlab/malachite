// Cells run in sessions: one session lease per language for the hub (paperboat-runtime/0 session mode:
// a live namespace shared by the hub's notes, as a Jupyter kernel is). Malachite runs no code itself
// (pb#415 §9): it asks paperboatd for the lease and speaks the protocol. Outputs are kept beside the
// note in `.malachite/out/<note id>/<cell hash>.json` (decision 16), with the runtime that made them.
import fs from "node:fs";
import path from "node:path";
import { Control, type Lease } from "./control.ts";
import { parse, type Lang } from "./note.ts";
import { Runtime, RuntimeError } from "./runtime.ts";
import type { Hub } from "./hub.ts";

export type Output =
  | { type: "stream"; name: string; text: string }
  | { type: "display"; data: Record<string, string> }
  | { type: "result"; data: Record<string, string> }
  | { type: "error"; error: { type?: string; message: string; traceback?: string } };
export type Run = {
  note: string; hash: string; lang: Lang; state: "queued" | "running" | "done" | "failed";
  ran?: string; ms?: number; outputs: Output[];
  runtime?: { name: string; version: string; backend: string; digest?: string; verified?: string };
};
type Session = { lease: Lease; rt: Runtime; cwd?: string };

/** Cells run in their note's folder, as Jupyter runs a notebook's (the daemon sets PAPERBOAT_PROJECT). */
function chdir(lang: Lang, dir: string): string {
  const s = JSON.stringify(dir);
  return lang === "julia" ? `cd(joinpath(ENV["PAPERBOAT_PROJECT"], ${s.replaceAll("$", "\\$")})); nothing` : `import os as _pb_os; _pb_os.chdir(_pb_os.path.join(_pb_os.environ["PAPERBOAT_PROJECT"], ${s})); del _pb_os`;
}

const INTERRUPT_GRACE_MS = 3000;   // after an interrupt with no reply, the session restarts (docs/runtime.md)
const safe = (id: string) => id.replace(/[^\w-]+/g, "_");
export class NoSession extends Error {}

export class Sessions {
  private sessions = new Map<Lang, Promise<Session>>();
  private queues = new Map<Lang, Promise<unknown>>();
  readonly running = new Map<Lang, Run>();

  private hub: Hub;
  private control: Control;
  private emit: (e: Record<string, unknown>) => void;

  constructor(hub: Hub, control: Control, emit: (e: Record<string, unknown>) => void) {
    this.hub = hub;
    this.control = control;
    this.emit = emit;
    control.onEvent = (e) => {
      this.emit({ type: "runtime", event: e });
      if (e.event === "runtime.exited" || e.event === "runtime.failed") {
        for (const [lang, p] of this.sessions) p.then((s) => { if (s.lease.id === e.lease || s.lease.id === (e as any).id) this.drop(lang); }, () => {});
      }
    };
    control.onClose = () => { for (const lang of [...this.sessions.keys()]) this.drop(lang); };
  }

  private session(lang: Lang): Promise<Session> {
    let p = this.sessions.get(lang);
    if (!p) {
      this.emit({ type: "session", lang, state: "starting" });
      p = (async () => {
        const lease = await this.control.call<Lease>("acquire", { runtime: lang, mode: "session", project: this.hub.root, owner: `malachite:${this.hub.name}` });
        if (lease.state === "failed") throw new Error(lease.error ?? `${lang} failed to start`);
        const rt = await Runtime.connect(path.join(lease.ipc, "runtime.sock"), 120_000);
        rt.onClose = () => this.drop(lang);
        this.emit({ type: "session", lang, state: "running" });
        return { lease, rt };
      })();
      p.catch((e) => { this.sessions.delete(lang); this.emit({ type: "session", lang, state: "failed", error: String(e?.message ?? e) }); });
      this.sessions.set(lang, p);
    }
    return p;
  }

  private drop(lang: Lang) {
    const p = this.sessions.get(lang);
    this.sessions.delete(lang);
    p?.then((s) => { s.rt.close(); this.control.call("release", { lease: s.lease.id }).catch(() => {}); }, () => {});
    this.emit({ type: "session", lang, state: "stopped" });
  }

  outDir(noteId: string) { return path.join(this.hub.root, ".malachite", "out", safe(noteId)); }

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
    const noteId = typeof n.props.id === "string" ? n.props.id : rel;
    const run: Run = { note: noteId, hash, lang: cell.lang, state: "queued", outputs: [] };
    const send = () => this.emit({ type: "cell", path: rel, run });
    send();
    const prev = this.queues.get(cell.lang) ?? Promise.resolve();
    const next = prev.then(async () => {
      run.state = "running";
      run.ran = new Date().toISOString();
      this.running.set(cell.lang, run);
      send();
      const t0 = Date.now();
      try {
        const s = await this.session(cell.lang);
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
        if (result?.data) run.outputs.push({ type: "result", data: result.data });
        run.state = "done";
      } catch (e) {
        run.outputs.push({ type: "error", error: e instanceof RuntimeError ? e.error : { type: "malachite", message: String((e as Error).message ?? e) } });
        run.state = "failed";
      }
      run.ms = Date.now() - t0;
      this.running.delete(cell.lang);
      fs.mkdirSync(this.outDir(noteId), { recursive: true });
      fs.writeFileSync(path.join(this.outDir(noteId), `${hash}.json`), JSON.stringify(run));
      this.hub.log("cell.ran", rel, { lang: cell.lang, hash, ok: run.state === "done", ms: run.ms });
      send();
    });
    this.queues.set(cell.lang, next.catch(() => {}));
    return run;
  }

  /** Stops the running cell: SIGINT through the daemon; a runtime that doesn't answer soon restarts. */
  async interrupt(lang: Lang) {
    const p = this.sessions.get(lang);
    if (!p || !this.running.has(lang)) return { interrupted: false };
    const s = await p;
    const run = this.running.get(lang);
    await this.control.call("interrupt", { lease: s.lease.id }).catch(() => s.rt.request("interrupt").catch(() => {}));
    setTimeout(() => { if (run && this.running.get(lang) === run) this.restart(lang); }, INTERRUPT_GRACE_MS);
    return { interrupted: true };
  }

  /** The editor's questions to a running session (paperboat-runtime/0 `lint`, `complete`): answered at
   *  once even while a cell runs; never starts a session just to ask. */
  async ask(lang: Lang, op: string, args: Record<string, unknown>) {
    if (op !== "lint" && op !== "complete") throw new Error(`${op} is not asked from the editor`);
    const p = this.sessions.get(lang);
    if (!p) throw new NoSession(`no ${lang} session runs`);
    return (await p).rt.request(op, args);
  }

  /** Ends every session and the daemon connection (which releases the leases). */
  close() { for (const lang of [...this.sessions.keys()]) this.drop(lang); this.control.close(); }

  /** A fresh session: the namespace is lost; the next cell starts a new one. */
  restart(lang: Lang) { this.drop(lang); return {}; }

  /** The runtimes key's peek: this hub's sessions with their stats, and what could start. */
  async peek() {
    const leases = await this.control.call<Lease[]>("ps");
    const mine = leases.filter((l) => l.owner === `malachite:${this.hub.name}` && l.project === this.hub.root);
    const sessions = await Promise.all(mine.map(async (l) => ({
      ...l,
      stats: await this.control.call("stats", { lease: l.id }).then((r: any) => r.stats, () => null),
      running: [...this.running.values()].filter((r) => r.lang === l.runtime && r.state === "running").map((r) => ({ note: r.note, hash: r.hash, since: r.ran })),
    })));
    const list = await this.control.call<{ runtimes: { name: string; version: string; modes: string[] }[] }>("runtimes.list");
    return { sessions, runtimes: list.runtimes.filter((r) => r.modes.includes("session")).map((r) => ({ name: r.name, version: r.version })) };
  }
}
