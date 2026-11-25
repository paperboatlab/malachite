<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/readme/banner-dark.webp">
    <img src=".github/readme/banner-light.webp" width="413" alt="Paperboat Malachite">
  </picture>
</h1>

An engineering notebook: notes, runs and results in one hub, with Julia and Python cells run by
Paperboat's runtimes. Part of [Paperboat](https://github.com/paperboatlab/paperboat).

A **hub** is a folder of Markdown notes and the files around them. Notes link with `[[name]]`, carry
their properties in a front matter, and hold cells (fenced `julia` or `python` blocks) that run in the
hub's session through `paperboatd`. Every change lands in an append-only log; a note can be sealed.

**Status:** v0.1, the first app on the new platform. Runs, the Log page and Settings come next; Julix's plots and
the other apps' embeds when those apps are rebuilt.

**Design:** [ARCHITECTURE.md](ARCHITECTURE.md) · **Spec:** pb#415 (paperboat-legacy) · **Look:**
[@paperboatlab/ui](https://github.com/paperboatlab/paperboat-ui) and the rebrand mockup
(`agent-docs/rebrand/apps/malachite`)

## Layout

```text
server/       the app server (Node 22, TypeScript, no dependencies): hub, index, sessions, the API
client/       the page (React, @paperboatlab/ui: tree, editor, plot, canvas; React Flow, marked), built into dist/
bin/malachite the command
examples/     tank-lab, a hub to try it on
test/         unit tests; e2e.test.ts runs a real cell when paperboatd is there
```

## Build

```sh
npm ci
npm run build        # the page into dist/
npm run typecheck
npm test             # e2e.test.ts too, when paperboatd is on PATH or $PAPERBOATD is set
```

## Run

```sh
bin/malachite examples/tank-lab          # http://127.0.0.1:59210/
bin/malachite ~/notes --port 59300       # any folder becomes a hub (.malachite/hub.toml) on first open
bin/malachite hub list                   # the hubs this machine knows: paperboat hub … once installed
bin/malachite hub history tank-lab       # its versions (Git underneath, outside the hub)
```

Cells need the Paperboat runtime daemon: `paperboatd` on PATH (the `paperboat-cli` package) or
`PAPERBOATD=/path/to/paperboatd`; it starts on demand and pulls the Julia or Python image the first
time. `/?open=<path>&mode=edit` opens a file.

## Licence

GNU General Public License version 3 (see [LICENSE](LICENSE)).
