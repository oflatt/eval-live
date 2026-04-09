"""eval_live – lightweight library for registering visualizations.

Create a Registry, add graphs and tables to it, and assign it to the
module-level ``registry`` variable so eval-live can find it.

Quick start::

    import eval_live

    reg = eval_live.Registry()
    reg.graph("My Graph", my_graph)
    reg.table("Mean Timing", mean_timing, filter_source=mean_timing_filter)
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
        import math
        result = []
        for row in data["timings"]:
            times = row["timing_list"]
            n = len(times)
            mean = sum(times) / n if n else 0
            result.append({"file": row["file"], "mean": round(mean, 4), "n": n})
        return result

Filters (filter_source)
-----------------------
When the user types in a computed table's filter box, only some computed
rows remain visible.  A ``filter_source`` function lets you propagate that
filter back to the *raw* data tables.

It receives two arguments:

- **filtered_rows**: the list of computed row dicts that are currently
  visible after the user's text filter.
- **data**: the *original* (unfiltered) data dict.

It returns a **new data dict** with the appropriate raw rows removed.
eval-live then hides raw-table rows that aren't in the returned data.

Example: if your computed table has one row per (file, treatment) pair,
the filter_source narrows raw timings to matching pairs::

    def mean_timing_filter(filtered_rows, data):
        # Build the set of primary keys the user wants to see
        keys = {(r["file"], r["treatment"]) for r in filtered_rows}
        # Return data with only the matching raw rows
        return {
            **data,
            "timings": [r for r in data["timings"]
                        if (r["file"], r["treatment"]) in keys],
        }

If multiple computed tables each have a filter_source, they are chained:
each one narrows the data further.  A table without filter_source has no
effect on the raw tables when filtered.
"""
import io
import base64

# The user script sets this module-level variable.
registry = None


class Registry:
    """Central object that holds all graph, table, and filter registrations.

    Create one in your script, register everything, then assign it to
    ``eval_live.registry`` so the JS engine can find it.
    """

    def __init__(self):
        self._graphs = []   # list of (name, fn)
        self._tables = []   # list of (name, fn, filter_source_fn | None)

    def graph(self, name, fn):
        """Register a graph function.

        Parameters
        ----------
        name : str
            Display name shown in the graph button bar.
        fn : callable
            ``fn(data) -> matplotlib.figure.Figure``
        """
        self._graphs.append((name, fn))

    def table(self, name, fn, filter_source=None):
        """Register a computed table function.

        Parameters
        ----------
        name : str
            Display name shown as the table heading.
        fn : callable
            ``fn(data) -> list[dict]``  — each dict is one row.
        filter_source : callable or None
            Optional.  ``filter_source(filtered_rows, data) -> data``
            Called when the user filters this computed table.  Receives
            the visible computed rows and the current data dict (which
            may already be narrowed by a previous table's filter_source);
            returns a new data dict with raw rows narrowed accordingly.
            See the module docstring for a full example.
        """
        self._tables.append((name, fn, filter_source))

    def run_graphs(self, data):
        """Run all registered graph functions and return rendered results.

        Returns a list of ``{"name": str, "src": str}`` dicts where *src*
        is a base64 data-URI PNG.  Called by the JS engine.
        """
        import matplotlib
        matplotlib.use("AGG")
        import matplotlib.pyplot as plt

        results = []
        for name, fn in self._graphs:
            fig = fn(data)
            buf = io.BytesIO()
            fig.savefig(buf, format="png", dpi=150)
            plt.close(fig)
            buf.seek(0)
            b64 = base64.b64encode(buf.read()).decode()
            results.append({"name": name, "src": f"data:image/png;base64,{b64}"})
        return results

    def run_tables(self, data):
        """Run all registered table functions and return their rows.

        Returns a list of ``{"name": str, "rows": list[dict],
        "has_filter_source": bool}`` dicts.  Called by the JS engine.
        """
        results = []
        for name, fn, fs in self._tables:
            rows = fn(data)
            results.append({
                "name": name,
                "rows": rows,
                "has_filter_source": fs is not None,
            })
        return results

    def apply_table_filters(self, table_filters, data):
        """Chain filter_source functions for all filtered computed tables.

        Called by the JS engine when the user filters one or more computed
        tables.

        Parameters
        ----------
        table_filters : list[dict]
            Each entry is ``{"name": str, "filtered_rows": list[dict]}``
            representing a computed table whose text filter is active.
        data : dict
            The original (unfiltered) data dict passed in by the JS
            engine.  Each ``filter_source`` is called in registration
            order, and each one receives the data already narrowed by
            the previous ``filter_source`` calls.

        Returns
        -------
        dict
            A new data dict with raw rows narrowed by each filter_source
            function in registration order.
        """
        filtered_data = data
        for name, _fn, fs in self._tables:
            if fs is None:
                continue
            for tf in table_filters:
                if tf["name"] == name:
                    filtered_data = fs(tf["filtered_rows"], filtered_data)
                    break
        return filtered_data
