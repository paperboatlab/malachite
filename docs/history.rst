History
=======

Every change to a hub is kept. You see versions and Restore, newest first; restoring brings a version
back and keeps the current one. Versions are kept as long as the hub's ``keep`` setting says
(``90d``, ``1y`` or ``always``).

Underneath it is Git, kept outside the hub (``$PAPERBOAT_HOME/hubs/<id>/git/``), and the history
travels with the hub as one file per machine (``.malachite/history/<machine>.bundle``). There is no
Git folder inside a hub.

.. note:: Not written yet: the History pane, restoring one file, the append-only log and sealed notes.
