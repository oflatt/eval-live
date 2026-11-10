"""Versioned flat JSON tables, provenance, and atomic single-writer storage."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
from types import MappingProxyType
from typing import Any, Iterator, Mapping

Scalar = str | int | float | bool | None
Data = dict[str, list[dict[str, Scalar]]]
SCHEMA_VERSION = 3
SYSTEM_TABLES = (
    "eval_metadata", "eval_invocations", "eval_argv", "eval_arguments",
    "eval_configs", "eval_environments", "eval_runs",
    "eval_processes", "eval_commands",
)


def scalar(value: Any) -> Scalar:
    """Normalize a scalar; reject nested values and non-finite numbers."""
    if isinstance(value, os.PathLike):
        return os.fspath(value)
    if value is None or type(value) in (str, int, bool):
        return value
    if type(value) is float and math.isfinite(value):
        return value
    raise ValueError(f"expected a finite JSON scalar, got {value!r}")


def parameters(values: Mapping[str, Any]) -> dict:
    """Normalize scalar/list parameters without losing types or list order."""
    result = {}
    for name, value in values.items():
        if not isinstance(name, str):
            raise ValueError("parameter names must be strings")
        result[name] = ([scalar(item) for item in value]
                        if isinstance(value, (list, tuple)) else scalar(value))
    return result


def readonly_parameters(values: Mapping[str, Any]) -> Mapping:
    """Normalize parameters into a read-only mapping with immutable sequences."""
    return MappingProxyType({key: tuple(value) if isinstance(value, list) else value
                             for key, value in parameters(values).items()})


def run_identity(*, repository, commit, benchmark, data_version, config_id, environment_id) -> dict:
    """Describe measurement identity for both planning and saved-run validation.

    Timeout is separate: eligibility depends on the outcome and requested
    deadline. Field names here are part of the persistent cache format.
    """
    return {"repository": repository, "commit": commit, "benchmark": benchmark,
            "version": data_version, "config": config_id, "environment": environment_id}


def digest(value: Any) -> str:
    """Hash canonical JSON (only used for identities, never stored as a cell)."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True,
                                     separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def parameter_rows(values: Mapping[str, Any], **identity: Scalar) -> list[dict]:
    """Encode a parameter mapping as flat rows, including empty lists/maps."""
    rows = []
    for name, value in parameters(values).items():
        sequence = isinstance(value, list)
        items = value if sequence else [value]
        if not items:
            rows.append(dict(identity, name=name, item_index=-1, kind="empty-list",
                             value_type="null", value=None))
        for index, item in enumerate(items):
            rows.append(dict(identity, name=name, item_index=index,
                             kind="list" if sequence else "scalar",
                             value_type="null" if item is None else type(item).__name__, value=item))
    return rows or [dict(identity, name=None, item_index=-1, kind="empty-mapping",
                         value_type="null", value=None)]


def read_parameters(rows: list[dict]) -> dict:
    """Decode rows for one parameter mapping, validating types and positions."""
    result = {}
    groups: dict[str, list[dict]] = {}
    if len(rows) == 1 and rows[0].get("kind") == "empty-mapping":
        if (rows[0].get("name") is not None or rows[0].get("value") is not None
                or type(rows[0].get("item_index")) is not int
                or rows[0].get("item_index") != -1 or rows[0].get("value_type") != "null"):
            raise ValueError("invalid empty mapping")
        return {}
    for row in rows:
        if type(row["item_index"]) is not int:
            raise ValueError("parameter positions must be integers")
        name = row["name"]
        if not isinstance(name, str):
            raise ValueError("invalid parameter name")
        value = scalar(row["value"])
        if row["value_type"] != ("null" if value is None else type(value).__name__):
            raise ValueError("parameter value type does not match its value")
        groups.setdefault(name, []).append(row)
    for name, items in groups.items():
        items.sort(key=lambda row: row["item_index"])
        kind = items[0]["kind"]
        if any(row["kind"] != kind for row in items):
            raise ValueError("mixed parameter kinds")
        if kind == "empty-list" and len(items) == 1 and items[0]["item_index"] == -1 and items[0]["value"] is None:
            result[name] = []
        elif kind in ("scalar", "list") and [row["item_index"] for row in items] == list(range(len(items))):
            if kind == "scalar" and len(items) != 1:
                raise ValueError("multiple values for a scalar parameter")
            result[name] = items[0]["value"] if kind == "scalar" else [row["value"] for row in items]
        else:
            raise ValueError("invalid parameter kind or positions")
    return result


def validate_tables(data: Any, *, user: bool = False) -> None:
    """Validate flat cells and table/column names; user tables reserve run_id."""
    if not isinstance(data, dict):
        raise ValueError("data must be a dictionary of named flat tables")
    for name, rows in data.items():
        if not isinstance(name, str) or not name or (user and name.startswith("eval_")):
            raise ValueError(f"invalid or reserved table name: {name!r}")
        if not isinstance(rows, list):
            raise ValueError(f"table {name!r} must contain a list of rows")
        for row in rows:
            if not isinstance(row, dict) or any(not isinstance(key, str) for key in row):
                raise ValueError(f"table {name!r} must contain dictionaries with string keys")
            if user and "run_id" in row:
                raise ValueError("run_id is supplied by eval-live")
            for value in row.values():
                # Paths are allowed in parameters, but stored cells are JSON scalars.
                if isinstance(value, os.PathLike):
                    raise ValueError("stored cells must be JSON scalars, not paths")
                scalar(value)


def atomic_write(path: Path, content: str | bytes) -> None:
    """Replace a file atomically after flushing a temporary sibling."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        binary = isinstance(content, bytes)
        with tempfile.NamedTemporaryFile(mode="wb" if binary else "w", encoding=None if binary else "utf-8", dir=path.parent,
                                         prefix=f".{path.name}.", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


class Store:
    """One JSON data file and its cache. Use :meth:`writer` before mutation.

    Loading validates the schema, scalar cells, and provenance references.
    Incompatible or corrupt files raise ``ValueError`` and are never replaced.
    A persistent sibling ``.lock`` file coordinates writers; it holds no data.
    """

    def __init__(self, path: str | Path):
        self.path = Path(path).expanduser().resolve()
        self._writing = False
        self.reload()

    def reload(self) -> None:
        """Reload the file, or create an empty in-memory store."""
        if self.path.exists():
            try:
                self.data = json.loads(self.path.read_text(encoding="utf-8"))
                self.validate()
            except (ValueError, TypeError, KeyError) as error:
                raise ValueError(f"invalid or incompatible eval-live data in {self.path}: {error}") from error
        else:
            self.data = {name: [] for name in SYSTEM_TABLES}
            self.data["eval_metadata"] = [{"schema_version": SCHEMA_VERSION, "writer_version": "0.2.0"}]

    def validate(self) -> None:
        """Reject unsupported schemas, malformed identities, and dangling links."""
        validate_tables(self.data)
        meta = self.data.get("eval_metadata", [])
        if len(meta) != 1 or type(meta[0].get("schema_version")) is not int or meta[0]["schema_version"] != SCHEMA_VERSION:
            raise ValueError(f"unsupported schema version; expected {SCHEMA_VERSION}. "
                             "Use a new --cache path, or the original eval-live version to read this file")
        if set(SYSTEM_TABLES) - self.data.keys():
            raise ValueError("missing metadata tables")
        if any(name.startswith("eval_") and name not in SYSTEM_TABLES for name in self.data):
            raise ValueError("unknown reserved metadata table")

        def identities(table, key):
            values = [row[key] for row in self.data[table]]
            if any(not isinstance(value, str) or not value for value in values) or len(set(values)) != len(values):
                raise ValueError(f"invalid or duplicate {key}")
            return set(values)

        invocations = identities("eval_invocations", "invocation_id")
        runs = identities("eval_runs", "run_id")
        processes = identities("eval_processes", "process_id")
        configs = {row["config_id"] for row in self.data["eval_configs"]}
        environments = {row["environment_id"] for row in self.data["eval_environments"]}
        for row in self.data["eval_invocations"]:
            if row["status"] not in ("running", "success", "failure", "interrupted"):
                raise ValueError("invalid invocation status")
            if type(row["collection_complete"]) is not bool:
                raise ValueError("invalid collection status")
        parameter_tables = (("eval_arguments", "invocation_id"), ("eval_configs", "config_id"),
                            ("eval_environments", "environment_id"))
        for table, key in parameter_tables:
            groups = {}
            for row in self.data[table]:
                groups.setdefault((row[key], row.get("scope", "")), []).append(row)
            decoded = {group: read_parameters(rows) for group, rows in groups.items()}
            if table == "eval_configs":
                by_config = {}
                for (config_id, scope), values in decoded.items():
                    by_config.setdefault(config_id, {})[scope] = values
                for config_id, scopes in by_config.items():
                    if set(scopes) != {"request", "arguments", "build"} or digest(scopes) != config_id:
                        raise ValueError("configuration identity does not match its parameters")
            elif table == "eval_environments":
                for (environment_id, _scope), values in decoded.items():
                    if digest(values) != environment_id:
                        raise ValueError("environment identity does not match its parameters")
            elif {identity for identity, _scope in groups} != invocations:
                raise ValueError("invocation has no saved arguments")
        for table, rows in self.data.items():
            references = {}
            if table in ("eval_argv", "eval_arguments", "eval_runs"):
                references["invocation_id"] = invocations
            if table not in SYSTEM_TABLES or table in ("eval_processes", "eval_commands"):
                references["run_id"] = runs
            for key, valid in references.items():
                if any(row.get(key) not in valid for row in rows):
                    raise ValueError(f"missing or dangling {key} in {table}")
        represented_runs = {row["run_id"] for name, rows in self.data.items()
                            if not name.startswith("eval_") for row in rows}
        for row in self.data["eval_runs"]:
            if row["run_id"] not in represented_runs:
                raise ValueError("attempt is missing its declared result rows")
            if row["config_id"] not in configs or row["environment_id"] not in environments:
                raise ValueError("run has no configuration or environment")
            if row["status"] not in ("pending", "running", "success", "failure", "timed-out", "interrupted"):
                raise ValueError("invalid run status")
            if not isinstance(row["cache_key"], str):
                raise ValueError("invalid cache identity")
            if not isinstance(row["commit"], str) or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", row["commit"]):
                raise ValueError("run must record a full commit hash")
            for key in ("benchmark", "repository", "data_version", "requested_ref"):
                if not isinstance(row[key], str) or not row[key]:
                    raise ValueError(f"invalid run {key}")
            if row["timeout"] is not None and (type(row["timeout"]) not in (int, float) or row["timeout"] <= 0):
                raise ValueError("invalid run timeout")
            if row["status"] == "success" and (type(row["seconds"]) not in (int, float) or row["seconds"] < 0):
                raise ValueError("successful run must have a duration")
            identity = run_identity(repository=row["repository"], commit=row["commit"],
                                    benchmark=row["benchmark"], data_version=row["data_version"],
                                    config_id=row["config_id"], environment_id=row["environment_id"])
            if row["cache_key"] != digest(identity):
                raise ValueError("cache identity does not match run provenance")
        process_runs = {row["process_id"]: row["run_id"] for row in self.data["eval_processes"]}
        for row in self.data["eval_commands"]:
            if row["process_id"] not in processes:
                raise ValueError("command has no process")
            if row["run_id"] != process_runs[row["process_id"]]:
                raise ValueError("command and process belong to different runs")
        for table, keys, position in (("eval_argv", ("invocation_id",), "position"),
                                      ("eval_commands", ("process_id",), "position")):
            groups = {}
            for row in self.data[table]:
                groups.setdefault(tuple(row[key] for key in keys), []).append(row[position])
            for positions in groups.values():
                if any(type(p) is not int for p in positions) or sorted(positions) != list(range(len(positions))):
                    raise ValueError(f"invalid or duplicate positions in {table}")

    @contextmanager
    def writer(self) -> Iterator[Store]:
        """Acquire the nonblocking writer lock, then reload under that lock."""
        if self._writing:
            raise RuntimeError("store writer is already active")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.with_name(self.path.name + ".lock").open("a+b") as handle:
            try:
                if os.name == "nt":
                    import msvcrt
                    handle.seek(0)
                    if not handle.read(1):
                        handle.write(b"\0")
                        handle.flush()
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise RuntimeError(f"another writer is using {self.path}") from error
            self._writing = True
            try:
                self.reload()
                yield self
            finally:
                self._writing = False
                if os.name == "nt":
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle, fcntl.LOCK_UN)

    def save(self) -> None:
        """Validate and checkpoint while holding the writer lock."""
        if not self._writing:
            raise RuntimeError("save requires Store.writer()")
        self.validate()
        atomic_write(self.path, json.dumps(self.data, indent=2, allow_nan=False) + "\n")

    def runs(self, cache_key: str) -> list[dict]:
        """Return all attempts for a measurement identity."""
        return [row for row in self.data["eval_runs"] if row["cache_key"] == cache_key]

    def cached(self, cache_key: str, *, timeout: float | None = None) -> list[dict]:
        """Return applicable cached observations in persistent attempt order.

        ``timeout=None`` means no deadline. Ordinary failures remain reusable
        until forced. Timeout rows are reusable at equal or smaller deadlines;
        a larger deadline permits fresh collection.
        A success fits an equal/longer deadline, or a shorter one if its total
        recorded attempt duration fits. Running/interrupted attempts never block.
        The newest applicable row determines reuse or retry for a treatment.
        """
        eligible = []
        for row in self.runs(cache_key):
            if row["status"] == "success":
                if timeout is None or (row["timeout"] is not None and row["timeout"] <= timeout) or row["seconds"] <= timeout:
                    eligible.append(row)
            elif row["status"] == "failure" or (row["status"] == "timed-out" and timeout is not None
                    and row["timeout"] is not None and timeout <= row["timeout"]):
                eligible.append(row)
        return eligible
