Commands
========

With Malachite installed, the Paperboat CLI has a ``hub`` group. The Launcher's Hubs page does the
same, one to one. Every list takes ``--json``.

.. list-table::
   :header-rows: 1

   * - ``paperboat …``
     - Does
   * - ``hub list``
     - The hubs: where each lives, its sync state
   * - ``hub show <hub>``
     - Where a hub lives, its sync and history
   * - ``hub new <name> [--in <folder> | --cloud <provider>]``
     - Make a hub
   * - ``hub add <folder>``
     - Add a hub folder that is already there
   * - ``hub rename <hub> <name>``
     - Rename a hub
   * - ``hub config <hub> [<key> [<value>]]``
     - Show or change a hub's settings
   * - ``hub move <hub> <folder> | --cloud <provider>``
     - Move a hub
   * - ``hub history <hub> [<path>]``
     - A hub's versions, newest first
   * - ``hub restore <hub> <version> [<path>]``
     - Bring back a version; the current one is kept
   * - ``hub remove <hub>``
     - Take a hub off the list; its files stay
