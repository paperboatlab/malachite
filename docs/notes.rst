Notes
=====

A note is a Markdown file. Notes link with ``[[name]]`` and carry their properties in a front matter.

.. note:: Not written yet: links and backlinks, properties, tags, the canvas, sealing a note.

Callouts
--------

A quote that starts with ``[!kind]`` is a callout: a box with the kind's icon and a title.

.. code-block:: markdown

   > [!tip] Zero the sensor first
   > Before every run.

   > [!question]- Why does it drift?
   > Temperature, probably.

The kinds, with the other names each one answers to: ``note``, ``abstract`` (``summary``, ``tldr``),
``info``, ``todo``, ``tip`` (``hint``, ``important``), ``success`` (``check``, ``done``), ``question``
(``help``, ``faq``), ``warning`` (``caution``, ``attention``), ``failure`` (``fail``, ``missing``),
``danger`` (``error``), ``bug``, ``example`` and ``quote`` (``cite``). A kind Malachite doesn't know is
shown as a note. Tips and successes are tinted in Malachite's colour, dangers, failures and bugs in red,
the rest in grey.

The title is optional: without one, the kind's name is the title. A ``+`` or ``-`` after the brackets
makes the callout fold: ``+`` starts open, ``-`` starts closed, and a click on its title opens or closes it.
Text size
---------

The − and + at the foot of a note make its text smaller or bigger, from 80 % to 160 %, in Read, Live and
Edit alike; a click on the size puts it back to 100 %. The keys are :kbd:`Ctrl =` (or :kbd:`Ctrl +`),
:kbd:`Ctrl -` and :kbd:`Ctrl 0`. Only the note's text changes: the rest of the window keeps its size.
Malachite remembers the size in this browser.
