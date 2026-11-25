Hubs
====

A hub is a folder that has ``.malachite/hub.toml``. Everything Paperboat writes for the hub itself is
under ``.malachite/``, hidden from every file tree, so your files stay plain files in any layout you
choose.

The hub's settings
------------------

``.malachite/hub.toml`` holds the settings that travel with the hub: ``id`` (how it is found again
after a rename or a move), ``name``, ``schema``, ``author``, ``created``, ``keep`` and ``ignore`` (what
is never versioned). Change them in Settings › Hub or with ``paperboat hub config``; don't edit the
file by hand. A ``hub.toml`` at the hub's root (schema 1) moves into ``.malachite/`` when the hub
opens.

``.malachite/`` holds ``hub.toml`` and ``history/``; the rest of it (``out/``, ``trash/``) can be
deleted while no Malachite has the hub open (``serving.pid`` tells ``hub move`` that one does).

The hubs on this machine
------------------------

``$PAPERBOAT_HOME/hubs.toml`` lists the hubs this machine knows, with where each lives here. Every
app reads it; each app picks its own hub from the selector in its bar. The Launcher lists and sets up
hubs but never picks one for an app.

Cloud hubs
----------

A cloud hub is a folder that another app syncs: Paperboat syncs nothing itself. Malachite names the
provider from the folder's path (Dropbox, OneDrive, Google Drive, iCloud Drive) and shows, for
example, "Dropbox's app syncs it".

When two machines change the same file, the sync app leaves a conflict copy. Malachite recognises
Dropbox's ``(… conflicted copy …)``, Syncthing's ``.sync-conflict-…`` and rclone bisync's
``.conflictN``: it marks them "conflict" in the tree, says so when the hub opens, and counts them in red
in the selector and in ``paperboat hub list``.

.. note:: Not written yet: making a cloud hub, resolving a conflict copy.
