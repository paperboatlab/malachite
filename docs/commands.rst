Commands
========

With Malachite installed, the Paperboat CLI has a ``hub`` group (``hubs`` is ``hub list``). The
Launcher's Hubs page does the same, one to one. Picking the hub to work in is the app's, so there is no
``hub open``.

.. list-table::
   :header-rows: 1

   * - ``paperboat …``
     - Does
   * - ``hub list [--json]``
     - The hubs: where each lives, its state
   * - ``hub show <hub> [--json]``
     - Where a hub lives, what it holds, its history
   * - ``hub new <name> [--in <folder>]``
     - Make a hub
   * - ``hub add <folder>``
     - Add a hub folder that is already there
   * - ``hub rename <hub> <name>``
     - Rename a hub; the folder keeps its name
   * - ``hub config <hub> [author|keep|ignore [<value>]]``
     - Show or change a hub's settings
   * - ``hub move <hub> <folder>``
     - Move a hub to another folder, or point it to where it is now
   * - ``hub history <hub> [<path>] [--json]``
     - A hub's versions, newest first: the whole hub, or one file or folder
   * - ``hub restore <hub> <version> [<path>]``
     - Bring back a version; the current one is kept too
   * - ``hub remove <hub>``
     - Take a hub off the list; its files stay

``hub move`` refuses while a Malachite has that hub open.
