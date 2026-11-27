Hubs
====

A hub is a folder that has ``.malachite/hub.toml``. Everything Paperboat writes for the hub itself is
under ``.malachite/``, hidden from every file tree, so your files stay plain files in any layout you
choose.

The hub's settings
------------------

``.malachite/hub.toml`` holds the settings that travel with the hub: ``id`` (how it is found again
after a rename or a move), ``name``, ``schema``, ``author``, ``created``, ``keep`` and ``ignore`` (what
is never versioned, nor shown in the file tree, the index, search or the graph: Git's patterns, such as
``stations/*/build/`` for a build folder). Change them in Settings › Hub or with ``paperboat hub config``; don't edit the
file by hand. A ``hub.toml`` at the hub's root (schema 1) moves into ``.malachite/`` when the hub
opens.

**out/ is not versioned.** A new hub's ``ignore`` is ``.malachite/out/ out/ *.tmp``: an ``out/`` folder
anywhere in the hub (where Articula and Julix export an FMU, a linear model, a gain) holds generated
files, made again from the hub, so its files stay on disk but out of the history and the file tree. To version them, take
``out/`` out of ``ignore`` (Settings › Hub, or ``paperboat hub config <hub> ignore ".malachite/out/
*.tmp"``). To keep one result in the history, put it beside ``out/`` instead of in it. A hub made before
keeps the ``ignore`` it has.

``.malachite/`` holds ``hub.toml`` and ``history/``; the rest of it (``out/``, ``trash/``) can be
deleted while no Malachite has the hub open (``serving.pid`` tells ``hub move`` that one does).

The hubs on this machine
------------------------

``$PAPERBOAT_HOME/hubs.toml`` lists the hubs this machine knows, with where each lives here. Every
app reads it; each app picks its own hub from the workspace well in its bar (after the menus), and
switching in one app leaves the others where they are. The Launcher lists and sets up hubs but never
picks one for an app.

Malachite switches hubs without a restart: opening another one ends the sessions of the one before and
saves its history. Close hub goes back to the Start page.

What every app shares
---------------------

Two files beside ``hubs.toml``, read by every Paperboat app and written whole (to a temporary file,
then renamed):

- ``recent.json``: what was opened, newest first, 40 at most: folders, hubs and files, each with the
  app that opened it. Malachite's Open recent and Start page show the hubs and its own notes; Clear
  recent takes those off and leaves the other apps' entries.
- ``settings.json``: the theme every app starts in (``light``, ``dark`` or ``system``). Changing it in
  one app writes it here.

Cloud hubs
----------

A cloud hub is a folder that another app syncs: Paperboat syncs nothing itself. Malachite names the
provider from the folder's path (Dropbox, OneDrive, Google Drive, iCloud Drive) and shows, for
example, "Dropbox's app syncs it".

When two machines change the same file, the sync app leaves a conflict copy. Malachite recognises
Dropbox's ``(… conflicted copy …)``, Syncthing's ``.sync-conflict-…`` and rclone bisync's
``.conflictN``: it marks them "conflict" in the tree, says so when the hub opens, and counts them in red
in the bar's hub menu and in ``paperboat hub list``.

.. note:: Not written yet: making a cloud hub, resolving a conflict copy.
