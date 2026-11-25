Cells
=====

A cell is a fenced ``julia`` or ``python`` block in a note. It runs in the hub's session for that
language, on a lease from ``paperboatd``; the runtime runs in a container and pulls its image the
first time. Outputs are kept under ``.malachite/out/``.

.. note:: Not written yet: running a cell or a note, outputs and plots, restarting a session.
