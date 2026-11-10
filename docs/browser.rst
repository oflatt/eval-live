Browser embedding
=================

``Registry.run`` generates an interactive page automatically. To embed the
viewer in another page, get the bundled assets as strings:

.. code-block:: python

   import eval_live

   eval_live.css()          # CSS stylesheet
   eval_live.js()           # JavaScript defining initEvalLive
   eval_live.pyodide_lib()  # Python library source for Pyodide

Include the CSS and JavaScript in the page, then initialize the viewer:

.. code-block:: javascript

   initEvalLive(container, data, name, graphScript, evalLivePy, extraModules)

``container``
   A DOM element or its ID.
``data``
   Named flat tables: ``{tableName: [rowObjects]}``. Keep them unchanged after
   initialization. Whole numbers must fit JavaScript's exact integer range;
   see :ref:`avoid-misleading-results`.
``name``
   The project name shown in the heading.
``graphScript`` (optional)
   Python source that builds a registry and assigns it to ``eval_live.registry``.
``evalLivePy`` (optional)
   Source returned by ``eval_live.pyodide_lib()``. Both Python source arguments
   are required for computed tables and graphs; raw tables work without them.
``extraModules`` (optional)
   ``{filename: source}`` mapping of additional Python modules made importable
   in Pyodide.

A browser script registers rendering callbacks, for example:

.. code-block:: python

   import eval_live

   reg = eval_live.Registry()
   reg.graph("Runtime", runtime)
   reg.table("Summary", summary, interactive_filter=narrow_summary)
   eval_live.registry = reg

The :doc:`python-guide` describes callback definitions, interactive filters,
and required metadata. Python outputs fetch Pyodide and matplotlib from a CDN;
the browser does not run benchmarks.

For a standalone JSON viewer, open ``eval_live/index.html`` and select a file.
