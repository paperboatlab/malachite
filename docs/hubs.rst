Hubs
====

A hub is a folder that has ``.malachite/hub.toml``. Everything Paperboat writes for the hub itself is
under ``.malachite/``, hidden from every file tree, so your files stay plain files in any layout you
choose.

The hub's settings
------------------

``.malachite/hub.toml`` holds the settings that travel with the hub: its ``id`` (how it is found again
after a rename or a move), ``name``, ``author``, how long versions are kept (``keep``) and what is
never versioned (``ignore``). Change them in Settings › Hub or with ``paperboat hub config``; don't
edit the file by hand.

The hubs on this machine
------------------------

``$PAPERBOAT_HOME/hubs.toml`` lists the hubs this machine knows, with where each lives here. Every
app reads it; each app picks its own hub from the selector in its bar. The Launcher lists and sets up
hubs but never picks one for an app.

Cloud hubs
----------

A cloud hub is a folder that Dropbox, OneDrive, Google Drive or iCloud syncs. Malachite flags the
conflict copies a sync makes.

.. note:: Not written yet: making a cloud hub, the ``local`` and ``metered`` machine settings,
   resolving a conflict copy.
