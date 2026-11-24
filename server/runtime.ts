// paperboat-runtime/0 (paperboat/docs/runtime.md), the client side: frames of [u32 LE length][JSON]
// on the runtime's socket in the lease's ipc folder. Requests run in order; output arrives as `stream`
// and `display` notifications carrying the request's id.
import net from "node:net";

export type Hello = { protocol: string; mode: string; runtime: { name: string; version: string }; ops: string[] };
export type Note = { type: "stream"; id: number; name: string; text: string } | { type: "display"; id: number; data: Record<string, string> } | { type: "log"; level: string; text: string };
export type ErrorInfo = { type?: string; message: string; traceback?: string };
export class RuntimeError extends Error { readonly error: ErrorInfo; constructor(error: ErrorInfo) { super(error.message); this.error = error; } }

export class Runtime {
  hello?: Hello;
  private buf = Buffer.alloc(0);
  private next = 1;
  private wait = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void; note?: (n: Note) => void }>();
  private ready!: Promise<Hello>;
  onLog: (n: Note) => void = () => {};
  onClose: () => void = () => {};

  private sock: net.Socket;
  private constructor(sock: net.Socket) { this.sock = sock; }

  /** Connects, retrying until the runtime listens (a first Julia start compiles), and waits for its hello. */
  static async connect(socket: string, timeoutMs = 60_000): Promise<Runtime> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        const s = await new Promise<net.Socket>((res, rej) => { const x = net.connect(socket); x.once("connect", () => { x.off("error", rej); res(x); }); x.once("error", rej); });
        const r = new Runtime(s);
        r.ready = new Promise((res, rej) => { r.wait.set(0, { resolve: res, reject: rej }); });
        s.on("data", (d) => r.data(d));
        s.on("close", () => { for (const w of r.wait.values()) w.reject(new RuntimeError({ type: "closed", message: "the runtime ended" })); r.wait.clear(); r.onClose(); });
        s.on("error", () => {});
        r.hello = await withTimeout(r.ready, Math.max(1000, end - Date.now()), "no hello from the runtime");
        return r;
      } catch (e) {
        if (Date.now() > end) throw e;
        await new Promise((z) => setTimeout(z, 100));
      }
    }
  }

  private data(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + n) break;
      let m: any;
      try { m = JSON.parse(this.buf.subarray(4, 4 + n).toString("utf8")); } catch { m = null; }
      this.buf = this.buf.subarray(4 + n);
      if (!m) continue;
      if (m.type === "hello") { this.wait.get(0)?.resolve(m); this.wait.delete(0); continue; }
      if (m.type === "stream" || m.type === "display") { this.wait.get(m.id)?.note?.(m); continue; }
      if (m.type === "log") { this.onLog(m); continue; }
      const w = this.wait.get(m.id);
      if (!w) continue;
      this.wait.delete(m.id);
      m.ok ? w.resolve(m.result) : w.reject(new RuntimeError(m.error ?? { message: "failed" }));
    }
  }

  request<T = any>(op: string, args: Record<string, unknown> = {}, note?: (n: Note) => void): Promise<T> {
    const id = this.next++;
    const body = Buffer.from(JSON.stringify({ id, op, args }), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    return new Promise<T>((resolve, reject) => {
      this.wait.set(id, { resolve, reject, note });
      this.sock.write(Buffer.concat([head, body]));
    });
  }

  close() { this.sock.destroy(); }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(what)), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}
