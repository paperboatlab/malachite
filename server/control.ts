// paperboat-control/0 (paperboat/docs/control.md): one JSON object per line to paperboatd over its Unix
// socket. Started on demand, as the CLI does: paperboatd beside `paperboat` on PATH, or $PAPERBOATD.
// A lease belongs to the connection that acquired it, so Malachite keeps one connection for its life.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export type Lease = {
  id: string; runtime: string; mode: string; owner: string; backend: string;
  state: "starting" | "running" | "idle" | "exited" | "failed"; error?: string;
  ipc: string; digest?: string; verified?: string; uptime_s?: number; idle_s?: number; project?: string;
};
export class ControlError extends Error {}

export function socketPath(env = process.env): string {
  const dir = env.PAPERBOAT_RUNTIME_DIR ?? (env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, "paperboat") : path.join(os.tmpdir(), `paperboat-${process.getuid?.() ?? 0}`));
  return path.join(dir, "control.sock");
}

function daemonPath(env = process.env): string | null {
  if (env.PAPERBOATD) return env.PAPERBOATD;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dir, "paperboatd");
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

const connect = (sock: string) => new Promise<net.Socket>((resolve, reject) => {
  const s = net.connect(sock);
  s.once("connect", () => { s.off("error", reject); resolve(s); });
  s.once("error", reject);
});

export class Control {
  private sock?: net.Socket;
  private buf = "";
  private next = 1;
  private wait = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
  private opening?: Promise<void>;
  onEvent: (e: Record<string, unknown>) => void = () => {};
  onClose: () => void = () => {};

  private path: string;
  private autostart: boolean;
  constructor(sock = socketPath(), autostart = true) { this.path = sock; this.autostart = autostart; }

  get connected() { return !!this.sock; }

  private async open() {
    let s: net.Socket;
    try { s = await connect(this.path); } catch (e) {
      if (!this.autostart) throw new ControlError(`paperboatd is not running (${this.path})`);
      const d = daemonPath();
      if (!d) throw new ControlError("paperboatd not found: install Paperboat (the paperboat-cli package) or set PAPERBOATD");
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      const log = fs.openSync(path.join(path.dirname(this.path), "paperboatd.log"), "a");
      spawn(d, ["--socket", this.path], { detached: true, stdio: ["ignore", log, log] }).unref();
      let last = e;
      for (let i = 0; i < 200; i++) {   // up to 20 s: a first start probes podman and docker
        await new Promise((r) => setTimeout(r, 100));
        try { s = await connect(this.path); break; } catch (err) { last = err; }
      }
      if (!s!) throw new ControlError(`paperboatd did not start (${String(last)}); see ${path.join(path.dirname(this.path), "paperboatd.log")}`);
    }
    s.setEncoding("utf8");
    s.on("data", (d: string) => this.data(d));
    s.on("close", () => {
      this.sock = undefined;
      for (const w of this.wait.values()) w.reject(new ControlError("paperboatd went away"));
      this.wait.clear();
      this.onClose();
    });
    s.on("error", () => {});
    this.sock = s;
    await this.call("subscribe");
  }

  private data(d: string) {
    this.buf += d;
    for (let i; (i = this.buf.indexOf("\n")) >= 0;) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      let m: any;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.event) { this.onEvent(m); continue; }
      const w = this.wait.get(m.id);
      if (!w) continue;
      this.wait.delete(m.id);
      m.ok ? w.resolve(m.result) : w.reject(new ControlError(m.error ?? "request failed"));
    }
  }

  async call<T = any>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.sock && op !== "subscribe") await (this.opening ??= this.open().finally(() => (this.opening = undefined)));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.wait.set(id, { resolve, reject });
      this.sock!.write(JSON.stringify({ id, op, args }) + "\n");
    });
  }

  close() { this.sock?.end(); }
}
