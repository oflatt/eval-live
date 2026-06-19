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


# The eval-live JS, split into cohesive modules. They are plain top-level
# function declarations sharing one global scope (NOT ES modules), so the
# order only needs to put a definition before any *top-level* use: the vendored
# AlaSQL global first, then the libraries (function declarations are hoisted, so
# cross-references between them resolve regardless of file order). `js()`
# concatenates them into a single inline <script>; index.html loads the same
# files as separate <script src> tags -- keep the two lists in sync.
_JS_MODULES = (
    "sql-filter.js",     # looksLikeSql / sqlMatchSet (AlaSQL) + checkbox-clause helpers
    "table-view.js",     # buildTable (table + filters + checkbox UI) + raw-table sync
    "graph-engine.js",   # initPyodideEngine (graphs + computed tables)
    "eval-live.js",      # initEvalLive (page wiring / entry point)
)


def js() -> str:
    """Return the eval-live JavaScript library as a single string.

    The vendored AlaSQL bundle (an in-memory SQL engine, MIT-licensed) is
    prepended, then the JS modules are concatenated, so everything loads in one
    self-contained ``<script>`` tag with ``alasql`` available as a global -- the
    filter box uses it to evaluate user-typed SQL WHERE clauses. AlaSQL makes no
    network calls for the in-memory ``SELECT ... FROM ? WHERE ...`` queries we
    run, so the page stays CSP-safe / fully self-contained.
    """
    alasql = (_PKG / "vendor" / "alasql.min.js").read_text(encoding="utf-8")
    parts = [alasql]
    parts += [(_PKG / m).read_text(encoding="utf-8") for m in _JS_MODULES]
    return "\n".join(parts)


def pyodide_lib() -> str:
    """Return the eval_live.py Pyodide library source as a string."""
    return (_PKG / "eval_live.py").read_text(encoding="utf-8")
