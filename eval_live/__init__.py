"""eval-live: interactive HTML tables and Pyodide-powered graphs for evaluation results."""
from importlib.resources import files

# Re-export the registry API so it is importable both in the browser (where
# `eval_live` IS the pyodide lib module) and locally (where `eval_live` is this
# package). Local code can build a Registry and call `render_to_dir` to write
# graphs/tables to disk without Pyodide.
from .eval_live import Registry, registry  # noqa: F401

_PKG = files(__package__)


def css() -> str:
    """Return the eval-live CSS stylesheet as a string."""
    return (_PKG / "eval-live.css").read_text(encoding="utf-8")


def js() -> str:
    """Return the eval-live JavaScript library as a string.

    The vendored AlaSQL bundle (an in-memory SQL engine, MIT-licensed) is
    prepended so it loads in the same self-contained ``<script>`` tag and is
    available as the global ``alasql`` -- the eval-live filter box uses it to
    evaluate user-typed SQL WHERE clauses. AlaSQL makes no network calls for
    the in-memory ``SELECT ... FROM ? WHERE ...`` queries we run, so the page
    stays CSP-safe / fully self-contained.
    """
    alasql = (_PKG / "vendor" / "alasql.min.js").read_text(encoding="utf-8")
    lib = (_PKG / "eval-live.js").read_text(encoding="utf-8")
    return alasql + "\n" + lib


def pyodide_lib() -> str:
    """Return the eval_live.py Pyodide library source as a string."""
    return (_PKG / "eval_live.py").read_text(encoding="utf-8")
