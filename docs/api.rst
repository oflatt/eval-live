Python API reference
====================

Registry
--------

A ``Registry`` declares collection callbacks and paper outputs. See
:doc:`python-guide` for examples and :doc:`data-format` for saved tables.

.. autoclass:: eval_live.Registry
   :members:

.. autofunction:: eval_live.select

.. autofunction:: eval_live.add_arguments

.. autofunction:: eval_live.warn

.. autofunction:: eval_live.error

Table presentation
------------------

Row keys become column headers in first-seen order. ``caption=`` adds text
below the table:

.. code-block:: python

   reg.table("Timings", timings, caption="Lower is better.")

Computed cells can contain scalars or styled display values:

.. code-block:: python

   {"text": "1.5x", "style": {"color": "green", "bold": True}}
   {"text": "slow", "style": "red"}

``style`` is visual only: a color string or a dictionary with ``color``,
``bold``, and ``dim``. Use basic color names (black, red, green, yellow, blue,
magenta, cyan, white) or hex colors such as ``#1b6b35`` for both terminal and
browser rendering. Terminal-only styles use Rich syntax; browser-only colors
use CSS syntax. LaTeX keeps the text and ignores styles. Stored measurements
must remain scalar cells; styling belongs in computed outputs.

Render caller-supplied data without collecting measurements:

.. code-block:: python

   reg.render_to_console(data)      # tables; graphs are skipped
   reg.render_to_dir(data, "out/")  # PDF graphs, JSON and LaTeX tables

The terminal renderer accepts an optional ``rich.Console``. Disk rendering
requires the ``render`` extra and clears the output directory; see
:doc:`cli` for path rules. A one-row input table such as
``data["params"] = [{"threshold": 0.5}]`` can pass parameters to these callbacks
and appears as a raw table in the viewer.

Benchmark callbacks
-------------------

``Registry.benchmark`` accepts the configuration fields of ``Benchmark``.
Collection callbacks receive a ``RunContext`` and return named flat tables.

.. autoclass:: eval_live.Benchmark
   :members:

.. autoclass:: eval_live.RunContext
   :members:

.. autofunction:: eval_live.run_command

.. autoclass:: eval_live.ProcessResult
   :members:

.. autoclass:: eval_live.ProcessError
   :members:

Plans, results, and storage
---------------------------

.. autoclass:: eval_live.Plan
   :members:

.. autoclass:: eval_live.EvaluationResult
   :members:

.. autoclass:: eval_live.Store
   :members:

Browser assets
--------------

.. autofunction:: eval_live.css

.. autofunction:: eval_live.js

.. autofunction:: eval_live.pyodide_lib

A standalone browser script assigns its registry to ``eval_live.registry``.
``Registry.run`` generates the page and connects the same registered callbacks
to their saved sample selections automatically.
See :doc:`browser` for embedding the viewer in another page.

LaTeX helpers
-------------

.. automodule:: eval_live.latex
   :members:
