History
=======

While Malachite runs, a version of the hub is made a few seconds after its files change. Changes made
while it is closed become one version ("Changes while Malachite was closed") the next time it opens.
History shows the versions, newest first; Restore brings back one file, a folder or the whole hub, and
keeps the current one too.

The hub's ``keep`` setting (``90d``, ``1y`` or ``always``) is stored but not applied yet: today every
version is kept.

Underneath it is Git, kept outside the hub (``$PAPERBOAT_HOME/hubs/<id>/git/``), and the history
travels with the hub as one file per machine (``.malachite/history/<machine>.bundle``). There is no
Git folder inside a hub.

.. note:: Not written yet: the History pane, the append-only log and sealed notes.
