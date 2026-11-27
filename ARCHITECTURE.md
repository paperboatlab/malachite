# Architecture

The plan and the decisions the spec left open: `plans/2026-11-24_21-50_malachite_v0_1.md` in the
workspace (pb#415). This page is the map.

## 1. Overview

Malachite is an app server and a page. The server owns the hub it works in (a folder; one at a time,
switched at runtime; none is the page's Start) and speaks two protocols of the platform: `paperboat-control/0` to `paperboatd` for leases, and `paperboat-runtime/0` to the
session runtimes the leases start. The page is a client of the server only.

```mermaid
flowchart LR
  P[page: React + @paperboatlab/ui] -- "HTTP JSON + SSE (127.0.0.1)" --> S
  subgraph S[malachite server]
    V[Hub: files, log, seal] --- I[Index: titles, links, tags]
    X[Sessions: one lease per language] --> C[Control client]
    X --> R[Runtime client]
  end
  C -- paperboat-control/0 --> D[paperboatd]
  R -- paperboat-runtime/0 --> K[(julia / python session)]
  D --> K
  V --- F[(the hub folder)]
```

## 2. Codemap

- `server/note.ts`: a note's parts: front matter (a YAML subset), title, tags, `[[links]]`, cells and
  their hashes. Pure functions.
- `server/hub.ts`: `Hub`: its settings in `.malachite/hub.toml` (schema 3: id, name, author, created, keep,
  ignore; a schema 1 `hub.toml` at the root moves there on open, a schema 2 root `log/` into `.malachite/log/`), set only through `set` (the Settings
  pane, `paperboat hub config`); every path through `resolve` (inside the hub, symlinks too), the tree,
  read/write (atomic), create (id, time, author set here), one property set (a board move), move, the trash (`.malachite/trash/<id>/` with `trashed.json`: list,
  restore beside a newcomer, delete for good, empty), seal, and
  the activity log (`.malachite/log/<machine>/YYYY-MM.jsonl`: a file per machine, so a sync never conflicts).
- `server/hubs.ts`: the hubs this machine knows, `$PAPERBOAT_HOME/hubs.toml` (id, path, place): every
  app and the Launcher read it; a hub is found by its id, so a rename or a move keeps it.
  Cloud hubs v1 are synced folders, as in Obsidian: the provider's desktop app keeps the folder in sync,
  `placeOf` names it from the path (Dropbox, OneDrive, Google Drive, iCloud Drive), and `conflictsIn`
  finds the copies a sync client leaves when two machines change a file (marked in the tree, told on
  open). Paperboat syncs nothing itself; the per-machine history bundles make that safe.
  It also keeps Malachite's side of the shared store (plans/2026-11-26_11-05_one_file_workflow.md, "The
  contract every app follows"): `recent.json` (hubs and notes as they open, newest first, 40 at most, every
  app's entries kept) and `settings.json` (the theme), both written whole to a temporary file, then renamed;
  `hubAbove` finds the hub a path lies in.
- `server/history.ts`: `History`: Git underneath, never shown. The Git folder lives outside the hub
  (`$PAPERBOAT_HOME/hubs/<id>/git`, work tree = the hub); a version a few seconds after files change
  (described in words), `versions` (the hub's or one file's), `restore` (the version before is kept);
  this machine's history packed in `.malachite/history/<machine>.bundle` (every few minutes and on
  close, written whole then renamed) and every other machine's bundle merged in on open (their past,
  the files as they are).
- `server/cli.ts`: `paperboat hub …` (through `commands.toml`, `bin/malachite hub …`): list, show, new,
  add, rename, config, move, history, restore, remove. `move` refuses a hub a Malachite serves (`.malachite/serving.pid`).
- `server/index.ts`: `Index`: built from the files at start, then kept by `apply(changed)` from `fs.watch`:
  only the paths a change batch names (a file read again, a folder that appeared walked, one that went
  taking what was under it), never the whole hub (a synced folder's every stat is the network); link
  resolution (path, name, the nearest of several) through a map of names, so a `[[name]]` never scans every
  item; backlinks with their line.
- `server/control.ts`: `Control`: one connection to `paperboatd` (started on demand, as the CLI does);
  leases belong to it, so closing it releases them.
- `server/runtime.ts`: `Runtime`: the framed client of a runtime's socket; requests in order, `stream`
  and `display` notifications by request id.
- `server/sessions.ts`: `Sessions`: one session lease per language for the hub; cells queue per
  language, run in their note's folder, and their outputs are written to
  `.malachite/out/<note id>/<cell hash>.json` with the runtime, image digest and backend that made them.
  Interrupt answers at once: SIGINT through the daemon, and no answer within 3 s restarts the session; a
  cell still waiting for its session stops the start. A start also stops when its lease's runtime ends,
  instead of waiting out the connect.
- `server/main.ts`: the HTTP server. The workspace is switched at runtime (`POST /api/workspace`: a known
  hub by id, a folder or a file by path, which opens the hub it lies in, `make` turning a plain folder into a
  hub, or nothing: the Start page); a plain folder answers 409 with `notHub`, as Malachite works in hubs
  only. Opening a hub builds its `Hub`, `History`, `Index`, `Sessions` and watcher (its `files` event says
  what changed, with the items: `changed`, `items`, `gone`, and `tree` when a file came or went, so the page
  patches its index and asks for the tree only then); the one before closes
  after (its sessions end, its history is saved, `serving.pid` goes), so a hub that can't open leaves the
  old one open. Every hub route answers 409 while none is open. Another app's file opens there (`paperboat app open <app> <hub> --no-open`,
  then `?open=<path>`: the app works in the hub) or is copied out to `~/Documents/paperboat/<app>/` (no tie
  to the hub); the page from `dist/`, the JSON API, Server-Sent Events, a file's bytes
  with byte ranges (a video seeks), and uploads (to a temporary name, then renamed; a replaced file goes to
  the trash, a taken name becomes "<name> (2)").
- `client/`: `App.tsx` (the shell: bar with the menu bar and the hub's workspace well, rail, cards, tabs,
  search, dialogs; one command list (`Command[]`: the kit's `fileMenu` with `hubOnly`, then Edit, View, Note,
  Help) read by `MenuBar`, the command search and `useShortcuts`, chords such as Ctrl Shift O included; Settings (the kit's `Settings`: General, Malachite, Editor, Hub,
  Shortcuts; Help › Keyboard shortcuts opens it on Shortcuts); the
  Start page with no hub; Open a hub (`ConnectHub`), our picker over the hub for Open file… and Save as…,
  `NotAHub`, `Unsaved` (the autosave waits while it asks), `TypedPath` in a browser and
  `window.paperboatShell`'s dialogs in a Paperboat window; tabs kept per hub; what is typed held outside the page's state (a key redraws the editor, not the page) and saved 700 ms after the last key; the index patched from the `files` events; a note as Read, Live (the kit
  editor with its `livePreview`, a cell's Run key saving then running it) or Edit; files that aren't notes, a CSV
  plotted), `Note.tsx` (properties, the Read view, cells and outputs), `fileMenu.ts` (the brand file menu
  for the kit's tree), `Graph.tsx` (the hub graph and the local graph, the kit's note graph), `Trash.tsx` (the hub card's trash), `Media.tsx` (pictures, videos, sounds: the kit's player and image
  editor; Read draws them into `.media-slot`s, Live through the kit's `embeds`), `Views.tsx` and `views.ts`
  (board, list, timeline over `views/*.toml`), `Side.tsx` (the Links card, the
  rows for the kit's runtimes key from `GET /api/runtimes`), `markdown.ts` (marked with wikilinks, embeds and callouts), `callouts.ts` (the callout kinds: aliases, icon, colour role), `noteSize.ts` (the note text's size: the foot's − size +, Ctrl = and Ctrl -, `--note-scale` on the note card), `files.tsx`, `api.ts`.
- **From the kit** (`@paperboatlab/ui`): the shell's parts (the bar `.win > .bar`, MenuBar and the command
  registry, WindowKeys, Rail, Panel, PanelsKey, Search, Menu, Dialog, Settings, ThemeSetting, ShortcutList, Toasts, Notifications,
  RuntimesKey), the one file workflow (`/workspace`: Start, WorkspaceWell, fileMenu, recentMenu, NotAHub,
  Unsaved, TypedPath, shell; `/hub`: ConnectHub, OpenFile, SaveFile, HubSettings), the file tree (`/files`), the editor with its
  languages, themes, tab strip and settings (`/editor`, `EditorTabs`, `EditorSettingsPane`:
  notes as Markdown, cells read-only, code files linted and completed by the hub's session through
  `POST /api/ask`), the plot (`/plot`), the graph layout (`/canvas`, drawn with React Flow). Malachite
  draws none of these itself.

## 3. Invariants

1. **The files are the record.** The index and `.malachite/` (but its `hub.toml`, the hub's id and
   settings, and `history/`, the versions) can be deleted; they come back from the files.
6. **No Git inside a hub.** No `.git` in the folder, no Git word on the page: versions and Restore. Nothing lives only in the server's memory.
2. **One writer for the log.** Every mutation through the API appends one event; the log is never
   rewritten. A damaged line is shown, not repaired.
3. **Sealed is final.** A sealed note refuses writes (409); its body hash is in its front matter and the
   page says when the body no longer matches.
4. **Paths stay in the hub.** Every path from the page goes through `Hub.resolve`.
   Dot folders (`.malachite/` with `hub.toml`) never show in the tree (paperboat#16).
5. **Malachite runs no code.** Cells run in runtimes leased from `paperboatd`; the server only speaks
   the protocols (paperboat ARCHITECTURE invariant 9).
6. **Formats it doesn't own are not parsed.** A `.pst`, `.mo` or `.mx` is indexed by name and type until
   its app publishes an index manifest; its embed says which app will draw it.
7. **Local only.** The server listens on 127.0.0.1 and answers only its own Host and Origin.
10. **One hub at a time, only hubs.** The server works in one hub or none; switching closes the old one's
   sessions and saves its history. A plain folder is never worked in: it becomes a hub first.
8. **A note's text is not trusted as HTML.** Raw HTML in Markdown is shown as text, links go to
   http(s), mailto or the hub, and runtime HTML output is shown as its text.

9. **No Git inside a hub.** No `.git` in the folder, no Git word on the page: versions and Restore.