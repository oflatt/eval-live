Development
===========

Run the tests
-------------

From the repository root:

.. code-block:: bash

   pip install -e '.[render,docs,test]'
   python -m unittest discover -s test -p 'test_*.py'
   node test/state.test.mjs
   node test/dom.test.mjs
   node test/graph-engine.test.mjs

Python integration tests cover subprocesses, worktrees, interruptions, and
report publication. `Hypothesis <https://hypothesis.readthedocs.io/>`_ properties
check parameter types, timeout reuse, treatment selection, exports, and figure
selections. A stateful test compares saves, failed writes, unsaved edits, and
reloads against a model of committed rows.

Local property runs generate fresh examples. CI uses the deterministic ``ci``
profile; reproduce it locally with ``HYPOTHESIS_PROFILE=ci``. For a larger
randomized run, use ``stress`` locally or select it when manually running the
Checks workflow in GitHub Actions:

.. code-block:: bash

   HYPOTHESIS_PROFILE=stress python -m unittest discover -s test -p 'test_properties.py'

The default profiles try up to 100 examples per property; ``stress`` tries
1,000. Stateful tests use one quarter as many sequences, with up to 25 steps
each. Failures print a minimized example and a temporary ``@reproduce_failure``
decorator. See `replaying failures
<https://hypothesis.readthedocs.io/en/latest/tutorial/replaying-failures.html>`_
for reproducing one with the same Hypothesis version. Keep regressions as
explicit ``@example`` inputs or ordinary tests. The local ``.hypothesis``
database is ignored by Git.

The JavaScript tests need no npm packages. They exercise state filtering,
reducers, typed selections, DOM controls, and the Python conversion boundary
using small DOM and runtime stubs. CI also exercises AlaSQL and real Pyodide
in Chromium. To run that check locally:

.. code-block:: bash

   pip install playwright
   python -m playwright install chromium
   python demo/eval.py --no-browser
   python test/browser_smoke.py

Build the documentation
-----------------------

.. code-block:: bash

   pip install -e '.[docs]'
   python -m sphinx -W --keep-going -b html docs docs/_build/html
   python -m sphinx -W -b doctest docs docs/_build/doctest

Open ``docs/_build/html/index.html``. Sphinx autodoc builds the API reference
from docstrings; Napoleon reads their NumPy-style parameter sections. Keep
examples executable and build with warnings treated as errors when changing
the public API.

Viewer architecture
-------------------

The viewer keeps saved rows in ``state.data``, controls in ``state.ui``, and the
current report in ``state.engine``. Saved rows remain unchanged. Raw tables,
computed tables, and diagnostics have independent controls even when their
display names match.

``state.js``
   State, reducers, and pure row-filtering functions, without DOM or async work.
``table-view.js``
   Persistent controls and visible rows. Updates preserve focus, filters, and
   collapse choices; row expansion is local display state.
``graph-engine.js``
   Python evaluation from a filter snapshot, followed by publication of the
   complete report. It owns no DOM.
``eval-live.js``
   ``initEvalLive`` connects state, controls, the engine, and page rendering.

``updateFilters(mutator)`` changes input controls and requests a calculation.
``setState(mutator)`` redraws presentation and engine results. Collapsing tables,
highlighting, and switching graph tabs do not recalculate outputs. SQL, column
text, and checkbox selections are independent constraints; rows must pass all
three. Clear all filters resets them all.

Each calculation applies raw-table filters, then computes tables before
narrowing. Those tables provide checkbox options and the selected output rows
for ``interactive_filter`` callbacks. The callbacks narrow inputs; their
allowed rows are intersected with the raw-filtered rows. The engine renders
tables, graphs, diagnostics, and visible raw rows from that result, respecting
each output's static ``requires`` selection. A computed table without
``interactive_filter`` only filters its own displayed rows.

Using tables from before narrowing prevents a filter from depending on its own
results and making choices disappear. Calculations run one at a time in a
shared Python runtime. Each captures its filters before awaiting Python.
If filters change, the current results or errors are discarded and the newest
queued selection is evaluated. The report appears together only for the current
selection; computed values stay hidden while it is pending or has failed.
Callbacks run on every input change; the Python runtime remains loaded.
