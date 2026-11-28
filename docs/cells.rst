Cells
=====

A cell is a fenced ``julia`` or ``python`` block in a note. It runs in the hub's session for that
language, on a lease from ``paperboatd``; the runtime runs in a container and pulls its image the
first time ("Downloading the Julia runtime" while it does). Outputs are kept under ``.malachite/out/``
(an example's in Paperboat's cache, so the example stays as it is).

Running cells
-------------

**Run** on a cell runs it in the note's folder. Cells of one language run one after another, and every
note of the hub shares the language's session: a variable set in one note is there in the next.
In the note's editor, :kbd:`Ctrl Enter` runs the cell the cursor is in (in Edit, where the cell is text).
**Note › Run all cells** (:kbd:`Ctrl Shift Enter`) runs the note's cells from the top, in order whatever their language; once a
cell fails or is stopped, the cells after it are skipped and keep the outputs they had.

**Stop** interrupts the running cell. A cell that doesn't stop within 3 s (a Julia loop that never
allocates or yields) restarts its session, and says so. **Note › Restart the Julia session** (or
Python) starts afresh: the variables are gone.

Outputs
-------

Text, values, errors with their traceback, and pictures (PNG, SVG) show under the cell. A JulixPlot
figure shows as its SVG. HTML from a runtime shows as its text.

Packages
--------

Packages are added with ``paperboat package add julia <name> --project <hub>`` (or Python), or in the
Launcher's Runtimes page (**Note › Manage runtimes…**); a session that doesn't find one yet finds it after a
restart. A hub's Julia packages are in its ``Project.toml`` and ``Manifest.toml``: when the hub was
copied, moved or synced from another machine, the first Julia session installs what the Manifest records
first ("Installing 37 packages from the hub's Manifest.toml") and leaves the Manifest as it is.
