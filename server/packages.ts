// A hub's Julia packages, made ready before its first Julia session (the way Julix does, julix#47). The
// session's project is the hub (`julia --project`), and its packages live in the deps volume paperboatd keeps
// per runtime and project path. A Manifest.toml whose packages that volume lacks (a hub copied, moved or
// synced from another machine, a fresh install, an example) is instantiated first: a short exec lease with
// the network for that step only, the project left read-only (the Manifest stays as it is; an example's is
// a `readonly` lease, never written). Python has no such step: `paperboat package add python` records nothing in the hub.
import fs from "node:fs";
import path from "node:path";
import type { Control, Lease } from "./control.ts";
import type { Hub } from "./hub.ts";

export class PackageError extends Error {}

/** What every lease on a hub asks for beside its project: an example's runtime may read and run it but never
 *  write into it (`readonly`, pb#91), which paperboatd enforces on every backend or refuses the backend. */
export const readonly = (hub: Pick<Hub, "example">) => (hub.example ? { readonly: true } : {});

/** The packages a Manifest.toml records from a registry or a repository (not the standard library's, nor a
 *  developed path's): their name, uuid and tree hash. */
export function recorded(manifest: string): { name: string; uuid: string; tree: string }[] {
  const out: { name: string; uuid: string; tree: string }[] = [];
  for (const block of manifest.split(/^(?=\[\[)/m)) {
    const name = /^\[\[(?:deps\.)?("?)([^"\]]+)\1\]\]/.exec(block)?.[2];
    const uuid = /^\s*uuid\s*=\s*"([0-9a-f-]{36})"/m.exec(block)?.[1];
    const tree = /^\s*git-tree-sha1\s*=\s*"([0-9a-f]{40})"/m.exec(block)?.[1];
    if (name && uuid && tree && !/^\s*path\s*=/m.test(block)) out.push({ name, uuid, tree });
  }
  return out;
}

// Pkg's folder for a version, `packages/<name>/<slug>`: Base.version_slug, five base-62 digits of the crc32c of
// the uuid (a UInt128's bytes, little-endian) and then the tree hash
const CRC = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? (n >>> 1) ^ 0x82f63b78 : n >>> 1; return n >>> 0; });
const crc32c = (bytes: Buffer, crc = 0) => { crc = ~crc >>> 0; for (const b of bytes) crc = CRC[(crc ^ b) & 0xff] ^ (crc >>> 8); return ~crc >>> 0; };
export function slug(uuid: string, tree: string): string {
  let y = crc32c(Buffer.from(tree, "hex"), crc32c(Buffer.from(uuid.replace(/-/g, ""), "hex").reverse()));
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 5; i++) { s += chars[y % 62]; y = Math.floor(y / 62); }
  return s;
}

/** The packages the hub's Manifest records that its deps volume (the host folder, or null: none yet) lacks. */
export function missing(root: string, deps: string | null): string[] {
  let manifest: string;
  try { manifest = fs.readFileSync(path.join(root, "Manifest.toml"), "utf8"); } catch { return []; }
  return recorded(manifest).filter((p) => !deps || !fs.existsSync(path.join(deps, "packages", p.name, slug(p.uuid, p.tree)))).map((p) => p.name);
}

/** The hub's Julia deps volume on the host, or null while there is none (paperboatd makes it on a first lease). */
export async function depsVolume(control: Control, root: string): Promise<string | null> {
  const [list, volumes] = await Promise.all([
    control.call<{ runtimes: { name: string; version: string; modes: string[] }[] }>("runtimes.list"),
    control.call<{ runtime: string; project: string; path: string; exists: boolean }[]>("volumes"),
  ]);
  const julia = list.runtimes.find((r) => r.name === "julia" && r.modes.includes("session"));
  const name = julia && `julia-${julia.version.split(".").slice(0, 2).join("-")}`;
  return volumes.find((v) => v.runtime === name && v.project === root && v.exists)?.path ?? null;
}

const DONE = "MALACHITE-DONE";
/** The Julia code that installs what the hub's Manifest records (and precompiles it), then says so. */
export const INSTANTIATE = `import Pkg; Pkg.activate(ENV["PAPERBOAT_PROJECT"]; io=devnull); Pkg.instantiate(); println("${DONE}")`;

/** The last line of Pkg's log worth showing ("Installed Cairo ─ v1.1.1", "Precompiling project…"). */
export function latest(log: string): string | undefined {
  return log.split(/[\r\n]/).map((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim()).filter((l) => l && l !== DONE).at(-1);
}

/** Installs the hub's Manifest into its deps volume; `progress` gets Pkg's latest line. `signal` stops it (the
 *  session was stopped before it started): its lease is released either way. */
export async function instantiate(control: Control, hub: Hub, owner: string, signal?: AbortSignal, progress?: (line: string) => void): Promise<void> {
  const lease = await control.call<Lease>("acquire", {
    runtime: "julia", mode: "exec", project: hub.root, ...readonly(hub), owner, command: ["julia", "--startup-file=no", "-e", INSTANTIATE], policy: { network: true },
  });
  try {
    for (let state = lease.state, shown = ""; state !== "exited" && state !== "failed";) {   // polls: exec leases report no progress event
      signal?.throwIfAborted();
      await new Promise((z) => setTimeout(z, 400));
      state = (await control.call<Lease[]>("ps")).find((l) => l.id === lease.id)?.state ?? "exited";
      if (progress) {
        const line = latest((await control.call<{ text: string }>("logs", { lease: lease.id, tail: 20 }).catch(() => ({ text: "" }))).text);
        if (line && line !== shown) progress(shown = line);
      }
    }
    const { text } = await control.call<{ text: string }>("logs", { lease: lease.id, tail: 4000 });
    if (!text.split(/\r?\n/).includes(DONE)) throw new PackageError(`Julia's package manager stopped:\n${text.slice(-1500)}`);
  } finally {
    control.call("release", { lease: lease.id, stop: true }).catch(() => {});
  }
}
