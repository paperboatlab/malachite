// `paperboat hub …` (Malachite's commands.toml; bin/malachite hub …): the hubs this machine knows and
// their settings, one command per control on the Launcher's Hubs page (paperboat#16). Words, never Git.
import fs from "node:fs";
import path from "node:path";
import { Hub, HubError, KEEP, peek, type HubKey } from "./hub.ts";
import { defaultFolder, find, forget, infos, remember, tilde, type HubInfo } from "./hubs.ts";

const placeName = (h: HubInfo) => (h.place === "google-drive" ? "Google Drive" : "Local");

function table(head: string[], rows: string[][]) {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  for (const r of [head, ...rows]) console.log(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("   ").trimEnd());
}

/** What a hub holds, for `hub show` and the Launcher's Overview. */
function holds(root: string) {
  const hub = new Hub(root), files = hub.files();
  const n = (re: RegExp) => files.filter((f) => re.test(f)).length;
  const bytes = files.reduce((s, f) => s + fs.statSync(path.join(root, f)).size, 0);
  return { notes: n(/\.md$/), runs: new Set(files.filter((f) => f.startsWith("runs/")).map((f) => f.split("/")[1])).size, models: n(/\.(mo|psf|pst)$/), files: files.length, bytes };
}
const size = (b: number) => (b < 1e6 ? `${Math.round(b / 1e3)} kB` : b < 1e9 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e9).toFixed(1)} GB`);

export function run(argv: string[]): number {
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const [group, verb, ...rest] = args;
  const need = (i: number, what: string) => { if (!rest[i]) throw new HubError(`which ${what}? paperboat hub ${verb} <${what}>`); return rest[i]; };
  const out = (data: unknown, words: () => void) => (json ? console.log(JSON.stringify(data, null, 2)) : words());
  if (group !== "hub") throw new HubError(`malachite ${group}: not a command (hub …)`);

  switch (verb) {
    case undefined:
    case "list": {
      const all = infos();
      out(all, () => {
        if (!all.length) return console.log("No hubs yet · paperboat hub new <name> makes one");
        table(["HUB", "WHERE", "STATE"], all.map((h) => [h.name, `${placeName(h)} · ${tilde(h.path)}`, h.missing ? "can't find the folder" : "on this computer"]));
      });
      return 0;
    }
    case "show": {
      const h = find(need(0, "hub"));
      if (h.missing) throw new HubError(`can't find ${h.name}'s folder (${tilde(h.path)}) · paperboat hub move ${h.name} <folder> points to where it is now`);
      const c = peek(h.path)!, x = holds(h.path);
      out({ ...h, ...c, holds: x }, () => {
        console.log(`${h.name.padEnd(9)}   ${placeName(h)} · ${tilde(h.path)}`);
        console.log(`holds       ${x.notes} notes · ${x.runs} runs · ${x.models} models · ${x.files} files · ${size(x.bytes)}`);
        console.log(`history     kept ${c.keep === "always" ? "always" : c.keep === "1y" ? "1 year" : "90 days"}`);
        console.log(`made        ${String(c.created).slice(0, 10)} by ${c.author} · hub format ${c.schema}`);
      });
      return 0;
    }
    case "new": {
      const name = need(0, "name");
      if (flag("--cloud")) throw new HubError("Google Drive hubs come with Malachite's Drive sync (paperboat#16); make it here and move it later");
      const dir = path.resolve(flag("--in") ?? defaultFolder(name));
      if (peek(dir)) throw new HubError(`${tilde(dir)} is a hub already · paperboat hub add ${tilde(dir)}`, 409);
      fs.mkdirSync(dir, { recursive: true });
      const hub = new Hub(dir);
      if (hub.name !== name) hub.set("name", name);
      remember(hub.id, hub.root);
      out({ id: hub.id, name, path: hub.root }, () => console.log(`made ${name} in ${tilde(hub.root)} · paperboat app open malachite ${tilde(hub.root)}`));
      return 0;
    }
    case "add": {
      const dir = path.resolve(need(0, "folder"));
      if (!fs.existsSync(dir) || !peek(dir)) throw new HubError(`${tilde(dir)} is not a hub · paperboat hub new <name> --in ${tilde(dir)} makes it one`);
      const hub = new Hub(dir);
      remember(hub.id, hub.root);
      out({ id: hub.id, name: hub.name, path: hub.root }, () => console.log(`added ${hub.name} (${tilde(hub.root)})`));
      return 0;
    }
    case "rename": {
      const h = find(need(0, "hub")), name = need(1, "name");
      new Hub(h.path).set("name", name);
      out({ ...h, name }, () => console.log(`${h.name} → ${name} (the folder keeps its name)`));
      return 0;
    }
    case "config": {
      const h = find(need(0, "hub")), [, key, value] = rest;
      const hub = new Hub(h.path), keys: HubKey[] = ["author", "keep", "ignore"];
      if (key === undefined) {
        out(Object.fromEntries(keys.map((k) => [k, hub.conf[k]])), () => table(["KEY", "VALUE"], keys.map((k) => [k, hub.conf[k]])));
        return 0;
      }
      if (!keys.includes(key as HubKey)) throw new HubError(`${key} is not a hub setting: ${keys.join(", ")} (keep: ${KEEP.join(" | ")})`);
      if (value === undefined) { out({ [key]: hub.conf[key as HubKey] }, () => console.log(hub.conf[key as HubKey])); return 0; }
      const from = hub.conf[key as HubKey];
      hub.set(key as HubKey, value);
      out({ [key]: value }, () => console.log(`${key.padEnd(9)}   ${from} → ${value}`));
      return 0;
    }
    case "move": {
      const h = find(need(0, "hub")), to = path.resolve(need(1, "folder"));
      if (flag("--cloud")) throw new HubError("Google Drive hubs come with Malachite's Drive sync (paperboat#16)");
      if (h.missing) {   // the folder was moved by hand: point the hub at where it is now
        const c = peek(to);
        if (c?.id !== h.id) throw new HubError(`${tilde(to)} is not ${h.name} (its id differs)`);
        remember(h.id, to);
        out({ ...h, path: to }, () => console.log(`${h.name} is at ${tilde(to)} now`));
        return 0;
      }
      if (fs.existsSync(to)) throw new HubError(`${tilde(to)} exists: name a new folder`, 409);
      const pid = Number(fs.existsSync(path.join(h.path, ".malachite", "serving.pid")) && fs.readFileSync(path.join(h.path, ".malachite", "serving.pid"), "utf8"));
      if (pid) { try { process.kill(pid, 0); throw new HubError(`Malachite has ${h.name} open: close it first (paperboat app stop malachite)`, 409); } catch (e) { if (e instanceof HubError) throw e; } }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      try { fs.renameSync(h.path, to); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
        fs.cpSync(h.path, to, { recursive: true, preserveTimestamps: true });   // another disk: copy, then remove
        fs.rmSync(h.path, { recursive: true, force: true });
      }
      remember(h.id, to);
      out({ ...h, path: to }, () => console.log(`moved ${h.name}: ${tilde(h.path)} → ${tilde(to)}`));
      return 0;
    }
    case "remove": {
      const h = find(need(0, "hub"));
      forget(h.id);
      out({ removed: h }, () => console.log(`${h.name} is off the list; its files stay in ${tilde(h.path)}`));
      return 0;
    }
    default:
      throw new HubError(`paperboat hub ${verb}: not a command (list, show, new, add, rename, config, move, remove)`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  try { process.exit(run(process.argv.slice(2))); } catch (e) {
    console.error(`paperboat hub: ${(e as Error).message}`);
    process.exit(e instanceof HubError ? 2 : 1);
  }
}
