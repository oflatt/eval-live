"""eval-live: interactive HTML tables and Pyodide-powered graphs for evaluation results."""
from importlib.resources import files

_PKG = files(__package__)


def css() -> str:
    """Return the eval-live CSS stylesheet as a string."""
    return (_PKG / "eval-live.css").read_text(encoding="utf-8")


def js() -> str:
    """Return the eval-live JavaScript library as a string."""
    return (_PKG / "eval-live.js").read_text(encoding="utf-8")


def pyodide_lib() -> str:
    """Return the eval_live.py Pyodide library source as a string."""
    return (_PKG / "eval_live.py").read_text(encoding="utf-8")
