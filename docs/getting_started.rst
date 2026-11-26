Getting started
===============

Install and open it with the Paperboat CLI (or the Launcher's Apps page). Installing pulls the Julia
and Python runtimes too.

.. code-block:: sh

   paperboat app install malachite
   paperboat app open malachite [<folder>]      # http://127.0.0.1:30474
   paperboat app stop malachite

A folder named on the command line opens as a hub: its settings are written on first open. The
``tank-lab`` example hub is a good place to start.

Without a folder, Malachite opens on the **Start** page: Open a hub… (the hubs this machine knows),
New hub…, Open folder… and Open file…, and the hubs and notes you opened last. Malachite works in hubs
only: a plain folder asks whether to make it a hub (its files stay where they are) or to open one of
your hubs. A note opened from outside the hub switches to the hub it lies in.

The window
----------

The bar holds the menus (File, Edit, View, Note, Help; every item is in the command search too, Ctrl K)
and, after them, the hub you work in: its menu switches to another hub, makes a new one or closes this
one (back to Start). The keys:

.. list-table::
   :header-rows: 1

   * - Keys
     - Does
   * - Ctrl N
     - New note
   * - Ctrl O
     - Open file…: a picker over the hub
   * - Ctrl Shift O
     - Open folder…: a hub, or a folder to make one
   * - Ctrl S, Ctrl Shift S
     - Save (notes save themselves as you type), Save as…
   * - Ctrl W
     - Close file
   * - Ctrl K
     - Search the hub or run a command
   * - Ctrl B, Ctrl Alt B
     - Show or hide the files and the links
   * - Ctrl ,
     - Settings
   * - Ctrl /
     - Keyboard shortcuts: every key, in Settings › Shortcuts

In a browser, Open folder… and Open file… take a typed path; in a Paperboat window they open the
system's dialog.

Settings (File › Settings…, the rail's Settings, Ctrl ,) is one window with a page per subject:
General (the theme, Light, Dark or System, which applies to every Paperboat app; View › Theme
sets it too), Malachite (how notes open and where cells run), Editor (the code's colours, font,
size, tabs, wrapping, completion and lint, for notes, cells and other files; a note's text always
wraps), Hub (the open hub's name, author, history and folder; with no hub open, Connect to a hub…)
and Shortcuts.

.. note:: Not written yet: a first note with a cell, a link and a property, with a screenshot.
