"""Register a paper's treatments, collectors, figures, tables, and macros.

Use ``Registry.run`` to collect required measurements and generate paper
outputs and an interactive report. ``requires`` selects treatments before
collection; ``interactive_filter`` narrows saved data in the browser.

For a standalone viewer with caller-supplied data, assign the rendering
registry to the module-level ``registry`` variable::

    import eval_live

    reg = eval_live.Registry()
    reg.graph("My Graph", my_graph)
    reg.table("Mean Timing", mean_timing, interactive_filter=mean_timing_filter)
    eval_live.registry = reg

Graphs
------
A graph function receives the data dict and returns a matplotlib Figure::

    def my_graph(data):
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots()
        ax.bar(["a", "b"], [1, 2])
        return fig

Tables
------
A table function receives the data dict and returns a list of row dicts.
These are rendered as filterable HTML tables below the raw data tables::

    def mean_timing(data):
        result = []
        for row in data["timings"]:
            times = row["timing_list"]
            n = len(times)
            mean = sum(times) / n if n else 0
            result.append({"file": row["file"], "mean": round(mean, 4), "n": n})
        return result

Interactive filters
-------------------
When the user types in a computed table's filter box, only some computed
output rows remain visible. ``interactive_filter`` uses those surviving output
rows to choose which input rows other tables and figures should receive.

It receives two arguments:

- **filtered_rows**: the list of computed row dicts that are currently
  visible after the user's text filter.
- **data**: the shared data dictionary after raw-table filters and any
  preceding interactive filters, including other outputs' commits and treatments.

It returns a **new data dict** containing the input rows to keep. eval-live
updates the raw-table views and recomputes displayed tables and figures from
those inputs. Saved data is unchanged.

Example: if your computed table has one row per (file, treatment) pair,
the interactive_filter narrows raw timings to matching pairs::

    def mean_timing_filter(filtered_rows, data):
        # Build the set of primary keys the user wants to see
        keys = {(r["file"], r["treatment"]) for r in filtered_rows}
        # Return data with only the matching raw rows
        return {
            **data,
            "timings": [r for r in data["timings"]
                        if (r["file"], r["treatment"]) in keys],
        }

If multiple computed tables each have an interactive_filter, they are chained:
each one narrows the data further.  A table without interactive_filter has no
effect on the raw tables when filtered.
"""
from __future__ import annotations

import io
import base64
from dataclasses import dataclass
import re
import sys
from types import MappingProxyType
from typing import Callable, Mapping

# The user script sets this module-level variable.
registry = None
_message_sink = None


def warn(message):
    """Report a computed warning without failing the evaluation.

    Identical messages are deduplicated across outputs and never stored.
    """
    _report("warning", message)


def error(message):
    """Report a computed error and continue rendering the remaining outputs.

    ``Registry.run`` fails after rendering if any errors were reported.
    Identical messages are deduplicated across outputs and never stored.
    """
    _report("error", message)


def _report(level, message):
    message = str(message)
    if _message_sink is None:
        print(f"{level.upper()}: {message}", file=sys.stderr)
    else:
        _message_sink(level, message)


@dataclass(frozen=True)
class _Output:
    """One registry entry; shared by planning, local export, and the browser."""

    kind: str
    id: str
    title: str
    render: Callable
    requires: Mapping
    caption: str | None = None
    interactive_filter: Callable | None = None

    def table_result(self, value):
        """Describe a table or macro result for the browser and terminal."""
        rows = ([{"macro": name, "value": item} for name, item in value.items()]
                if self.kind == "macros" else value)
        return {"name": self.title, "rows": rows,
                "has_interactive_filter": self.interactive_filter is not None,
                "caption": self.caption}


def _requirements(requires):
    if requires is None or requires == {}:
        return {"data": None}
    if callable(requires):
        requires = {"data": requires}
    if not isinstance(requires, Mapping):
        raise ValueError("requires must be a treatment selector or named selectors")
    if any(not isinstance(name, str) or not name or not callable(selector)
           for name, selector in requires.items()):
        raise ValueError("each named requirement must be a treatment selector")
    return MappingProxyType(dict(requires))


def _select_rows(data, ids):
    result = {
        table: [dict(row) for row in rows if row.get("run_id") in ids]
        for table, rows in data.items()
        if not table.startswith("eval_") or table in ("eval_runs", "eval_selections")
    }
    configs = {row["config_id"] for row in result.get("eval_runs", [])}
    result["eval_configs"] = [dict(row) for row in data.get("eval_configs", [])
                              if row["config_id"] in configs]
    result["eval_requirements"] = [dict(row) for row in data.get("eval_requirements", [])]
    return result


def _scoped_data(data, selections):
    result = _select_rows(data, {run_id for ids in selections.values() for run_id in ids})
    # A callback sees only this output's named selections, even when the same
    # observation has different roles in other outputs or earlier invocations.
    result["eval_requirements"] = [{"requirement": name} for name in selections]
    result["eval_selections"] = [{"requirement": name, "run_id": run_id}
                                for name, ids in selections.items() for run_id in ids]
    return result


def select(data: dict, requirement: str) -> dict:
    """Select one named requirement from a registry callback's data dictionary.

    For ``requires={"baseline": old, "candidate": new}``, use
    ``select(data, "baseline")["measurements"]``. The callback's ordinary data
    tables contain the union of its requirements. Returned rows are copied,
    and selection still works after interactive filters remove all measurements.
    """
    rows = data.get("eval_selections", [])
    names = {row["requirement"] for row in data.get("eval_requirements", []) + rows}
    if requirement not in names:
        raise ValueError(f"unknown requirement: {requirement!r}")
    return _select_rows(data, {row["run_id"] for row in rows if row["requirement"] == requirement})


class Registry:
    """Register a paper's benchmarks, graphs, tables, and LaTeX macros.

    Rendering callbacks receive dictionaries of named tables. ``requires=``
    selects treatments for each output. ``run(args=..., argv=...)`` collects
    their data and generates paper outputs plus interactive HTML.

    ``selection_arguments`` names paper-specific options that select work
    without changing measurements. ``browser_source`` is a Path or source
    string containing top-level rendering callbacks; their common source file
    is used by default. Guard local execution with ``if __name__ == '__main__'``.
    """

    def __init__(self, *, selection_arguments=(), browser_source=None, title="Paper evaluation"):
        self._outputs = []
        self._benchmarks = {}
        self.selection_arguments = set(selection_arguments)
        self.browser_source = browser_source
        self.title = title
        self._messages = {}
        self._message_handler = None
        self._selections = None

    def _evaluate(self, output, data, *, capture_errors=True):
        """Evaluate one output with its saved selection and replace its diagnostics.

        Results are not retained. Callback errors become diagnostics and an empty
        result unless ``capture_errors=False``, which propagates the exception.
        KeyboardInterrupt always propagates. Interactive filters use shared data
        separately from this per-output selection.
        """
        global _message_sink
        messages = {}

        def emit(level, message):
            messages[level, message] = None
            if self._message_handler:
                self._message_handler(level, message)

        previous, _message_sink = _message_sink, emit
        try:
            if self._selections is not None:
                data = _scoped_data(data, self._selections[output.id])
            value = output.render(data)
            if output.kind == "table" and (not isinstance(value, list) or any(not isinstance(row, dict) for row in value)):
                raise ValueError("table callbacks must return a list of row dictionaries")
            if output.kind == "macros" and not isinstance(value, Mapping):
                raise ValueError("macro callbacks must return a mapping of names to values")
            return value
        except Exception as exception:
            if not capture_errors:
                raise
            emit("error", f"{output.title}: {exception}")
            return {} if output.kind == "macros" else [] if output.kind == "table" else None
        finally:
            self._messages[output.title] = messages
            _message_sink = previous

    def run_messages(self):
        """Return derived Warnings and Errors tables from the latest callbacks.

        Re-evaluating a callback replaces its previous messages. Identical
        level/message pairs are deduplicated across outputs. Nothing is added
        to the measurement data or its cache.
        """
        messages = dict.fromkeys(item for group in self._messages.values() for item in group)
        return [{"name": name, "rows": [{"message": message} for kind, message in messages if kind == level],
                 "has_interactive_filter": False, "caption": None}
                for level, name in (("warning", "Warnings"), ("error", "Errors"))]

    def benchmark(self, name, fn=None, *, version, error_rows, treatments=None, repository=".", **options):
        """Register ``fn(context) -> named flat tables`` for one observation.

        ``treatments`` is an iterable of configuration dictionaries (default:
        one empty configuration). Selectors see all registered treatments,
        with ``benchmark`` and ``repository`` fields added. A treatment can
        override the registered repository. Requested treatments without a
        ``commit`` use the CLI's ``--commit`` (default HEAD). Output selectors
        can add or change ``commit`` to request other revisions of a treatment.

        Required ``error_rows(treatment, status)`` returns named flat tables
        for ``pending``, ``timed-out``, ``failure``, and ``interrupted`` work.
        It must be pure and supply rows in the same tables for every status.
        All requested rows are saved before collection. Successful results
        replace placeholders and must cover every declared table. Timeouts and
        failures are ordinary data; renderers choose whether to warn or error.

        Treatments run sequentially unless marked ``parallel=True``. Marked
        treatments may use separate processes up to ``--jobs`` (CPU count by
        default); unmarked treatments run alone. Parallel collectors must be
        importable top-level functions. The flag and worker limit are saved
        with the configuration and affect cache identity.

        ``version`` identifies the tables' format/meaning and affects cache
        identity. Options are fields of :class:`eval_live.Benchmark`:
        ``inputs``, ``dependencies``, ``build``,
        ``build_config``, ``environment``, ``tools``, and ``timeout`` (seconds
        per command, default None for no limit). Registration does not collect.
        Omit ``fn`` to use ``@reg.benchmark(name, version=..., ...)``.
        """
        if fn is None:
            return lambda callback: self.benchmark(name, callback, version=version, error_rows=error_rows, treatments=treatments,
                                                   repository=repository, **options)
        if not callable(fn):
            raise ValueError("benchmark callback must be callable")
        if name in self._benchmarks:
            raise ValueError(f"duplicate benchmark: {name!r}")
        self._benchmarks[name] = {
            "benchmark": dict(name=name, run=fn, version=version, error_rows=error_rows, **options),
            "treatments": tuple(dict(row) for row in ([{}] if treatments is None else treatments)),
            "repository": str(repository),
        }
        return fn

    def _add(self, kind, name, fn, requires, id, caption=None, interactive_filter=None):
        if fn is None:
            return lambda callback: self._add(kind, name, callback, requires, id, caption, interactive_filter)
        if not callable(fn):
            raise ValueError("output callback must be callable")
        output_id = id
        if output_id is None and kind == "table":
            output_id = getattr(fn, "__name__", None)
            if output_id == "<lambda>":
                output_id = None
        if output_id is None:
            output_id = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "graph"
        if not re.fullmatch(r"[a-zA-Z0-9_][a-zA-Z0-9_-]*", output_id):
            raise ValueError("output IDs must be filename-safe letters, digits, underscores, or hyphens")
        self._outputs.append(_Output(kind, output_id, name, fn, _requirements(requires), caption, interactive_filter))
        return fn

    def graph(self, name, fn=None, *, requires=None, id=None):
        """Register ``fn(data) -> matplotlib.figure.Figure``.

        Return ``None`` to omit a figure. File export also removes that figure's
        previous generated file.

        ``name`` is the display title. ``requires(treatments)`` selects the
        treatments needed by this output before collection. Omit it to select
        the whole catalog. Interactive filtering never changes this selection.
        A mapping of named selector functions supports comparisons. Selectors
        receive read-only dictionaries and return declared treatments or copies.
        Copies may add, change, or omit ``commit``; other configuration fields
        must match a declared treatment. An omitted commit uses ``--commit``
        (default HEAD). Commit aliases resolving to the same run share data.
        ``run`` passes only this output's selected observations to the callback.
        ``id`` defaults to a slug of the name and controls filenames and
        ``--only`` selection. Direct ``run_graphs(data)`` uses the supplied data.
        Use ``@reg.graph(name, ...)`` to register a function where it is defined.
        Both forms return the original function, without wrapping it.
        """
        return self._add("graph", name, fn, requires, id)

    def table(self, name, fn=None, interactive_filter=None, *, caption=None, requires=None, id=None):
        """Register ``fn(data) -> list[dict]``; row keys are column headings.

        Cells can be scalars or styled ``{"text": ..., "style": ...}`` values.
        ``interactive_filter(filtered_rows, data) -> data`` selects input rows
        to keep based on the computed output rows still visible after the user's
        filter. It receives shared data across all outputs, after raw-table
        filters and preceding interactive filters. Return a new data dictionary
        containing those inputs; tables and figures are recomputed from it.
        Without this callback, filtering affects only this table's view. Preserve other
        tables and metadata with ``{**data, ...}``. Filters chain in registration
        order and never collect data. ``caption`` is shown below the table in
        the terminal and browser. ``requires`` works as in :meth:`graph` and
        limits the rendering callback's data, not the interactive filter's data.
        ``id`` defaults to the function name and controls filenames and ``--only``.
        Lambdas and callables without names use a slug of the display title.
        Set ``id`` explicitly when registering the same function more than once.
        ``@reg.table(name, ...)`` is the equivalent decorator form.
        """
        return self._add("table", name, fn, requires, id, caption, interactive_filter)

    def macros(self, name, fn=None, *, requires=None, id=None):
        """Register ``fn(data) -> {LaTeXMacroName: scalar_value}``.

        Macro names contain letters only; values are LaTeX-escaped. Local
        export writes a ``.tex`` file, and the browser/terminal shows the names
        and values as a table. ``requires`` and ``id`` work as in :meth:`graph`.
        ``@reg.macros(name, ...)`` is the equivalent decorator form.
        """
        return self._add("macros", name, fn, requires, id)

    def plan(self, *, args=None):
        """Inspect selected outputs, cached observations, and missing work without writes."""
        from .planning import _Runner
        return _Runner(self).plan(args=args)

    def run(self, *, args=None, argv=None):
        """Collect required observations and write paper outputs plus HTML.

        Save all CLI arguments/defaults and data as flat tables in one JSON
        file. ``--timeout`` overrides command deadlines; raising it preserves
        successful samples and recollects timed-out work. ``--dry-run`` inspects
        the plan; ``--render-only`` replays saved selections without benchmarks.

        Every requested treatment has measured or explicit error rows. Ctrl+C
        stops collection and rendering. Figure warnings/errors are computed,
        deduplicated, and never stored; reporting errors fail after rendering.

        Only measurement data is cached. Validation and ``--dry-run`` leave the
        previous report in place. Once collection or rendering starts, its files
        are removed; new files are published only after successful rendering.
        Errors or Ctrl+C preserve saved data. Use separate output directories to
        retain reports or run concurrent invocations.
        """
        from .planning import _Runner
        return _Runner(self).run(args=args, argv=argv)

    def run_graphs(self, data):
        """Run all registered graph functions and return rendered results.

        Returns a list of ``{"name": str, "src": str}`` dicts where *src*
        is a base64 data-URI PNG.  Called by the JS engine.
        """
        import matplotlib
        matplotlib.use("AGG")
        import matplotlib.pyplot as plt

        results = []
        for output in self._outputs:
            if output.kind != "graph":
                continue
            fig = self._evaluate(output, data)
            if fig is None:
                continue
            buf = io.BytesIO()
            try:
                fig.savefig(buf, format="png", dpi=150)
            finally:
                plt.close(fig)
            buf.seek(0)
            b64 = base64.b64encode(buf.read()).decode()
            results.append({"name": output.title, "src": f"data:image/png;base64,{b64}"})
        return results

    def render_to_dir(self, data, outdir, fmt="pdf", dpi=150):
        """Render supplied data to graph, table, and macro files locally.

        Graphs use ``fmt`` (PDF by default); nonempty tables produce JSON and
        LaTeX. Macros produce LaTeX. Return the written paths. No benchmarks run:
        ``requires`` is used by :meth:`run`, which stores data in one JSON file
        without table sidecars.
        Replace the previous generated outputs in this directory. A rendering
        exception removes those outputs; unrelated files are preserved.
        """
        from .render import render_outputs
        return [str(path) for path in render_outputs(data, self, outdir,
                                                    fmt=fmt, dpi=dpi, table_json=True)]

    def run_tables(self, data):
        """Run all registered table functions and return their rows.

        Returns a list of ``{"name": str, "rows": list[dict],
        "has_interactive_filter": bool, "caption": str|None}`` dicts.  Called by the
        JS engine.
        """
        return [output.table_result(self._evaluate(output, data))
                for output in self._outputs if output.kind != "graph"]

    def render_to_console(self, data, tables=None, console=None):
        """Render registered tables to a terminal with rich (graphs are skipped).

        ``tables`` is an optional ordered list of table names to render (others
        skipped; empty tables skipped); ``None`` renders all. ``console`` is an
        optional ``rich.Console``; it is returned. See ``console.py``.
        """
        from . import console as console_renderer

        outputs = [output for output in self._outputs if output.kind != "graph"]
        if tables is not None:
            by_name = {output.title: output for output in outputs}
            missing = [name for name in tables if name not in by_name]
            if missing:
                raise ValueError(f"unknown table(s): {missing}")
            outputs = [by_name[name] for name in tables]
        results = (output.table_result(self._evaluate(output, data, capture_errors=False)) for output in outputs)
        return console_renderer.render(results, console)

    def apply_table_filters(self, table_filters, data):
        """Chain interactive_filter functions for all filtered computed tables.

        Called by the JS engine when the user filters one or more computed
        tables.

        Parameters
        ----------
        table_filters : list[dict]
            Each entry is ``{"name": str, "filtered_rows": list[dict]}``
            representing a computed table whose text filter is active.
        data : dict
            Shared data across all outputs, after raw-table filters. Each
            ``interactive_filter`` is called in registration order and receives
            data already narrowed by preceding interactive filters. ``requires``
            does not restrict the data passed to these callbacks.

        Returns
        -------
        dict
            A new data dict with raw rows narrowed by each interactive_filter
            function in registration order.
        """
        filtered_data = data
        selected = {table["name"]: table["filtered_rows"] for table in table_filters}
        for output in self._outputs:
            if output.interactive_filter is not None and output.title in selected:
                filtered_data = output.interactive_filter(selected[output.title], filtered_data)
        return filtered_data
