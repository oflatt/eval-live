"""Benchmark callbacks and subprocess measurement helpers."""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import inspect
import math
import os
from pathlib import Path
import signal
import subprocess
import time
from typing import Callable, Mapping, Sequence

from .store import Data, digest, parameters, readonly_parameters, validate_tables


@dataclass
class ProcessResult:
    """Outcome of a command, including diagnostics for failed attempts."""

    argv: tuple[str, ...]
    cwd: str
    seconds: float
    returncode: int | None
    stdout: str
    stderr: str
    status: str


class ProcessError(RuntimeError):
    """A command failed or timed out; ``result`` retains its diagnostics."""

    def __init__(self, result: ProcessResult):
        self.result = result
        super().__init__(f"command {result.status} (exit {result.returncode}): {result.argv!r}")


class ProcessInterrupted(KeyboardInterrupt):
    """An interrupted process whose captured diagnostics can still be saved."""

    def __init__(self, result: ProcessResult):
        self.result = result


def run_command(argv: Sequence[str | Path], *, cwd: str | Path | None = None,
                timeout: float | None = None, env: Mapping[str, str] | None = None,
                check: bool = True) -> ProcessResult:
    """Measure a command without a shell, capturing stdout, stderr, and status.

    ``timeout=None`` means no deadline. ``env`` augments the current environment.
    A timeout or interrupt terminates the process group on POSIX, and the child
    on Windows. Nonzero exits and
    timeouts raise ``ProcessError`` when ``check`` is true. Use
    ``RunContext.command`` to also persist this information automatically.
    """
    if timeout is not None and (type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0):
        raise ValueError("timeout must be None or a finite positive number")
    args = tuple(os.fspath(value) for value in argv)
    if not args:
        raise ValueError("command must not be empty")
    started = time.perf_counter()
    process = subprocess.Popen(args, cwd=cwd, env={**os.environ, **(env or {})},
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding="utf-8", errors="replace",
                               start_new_session=os.name != "nt")
    status = "success"
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
        if os.name == "nt":
            process.kill()
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        stdout, stderr = process.communicate()
        status = "interrupted" if isinstance(error, KeyboardInterrupt) else "timed-out"
    if process.returncode and status == "success":
        status = "failure"
    result = ProcessResult(args, str(Path(cwd or Path.cwd()).resolve()),
                           time.perf_counter() - started, process.returncode, stdout, stderr, status)
    if status == "interrupted":
        raise ProcessInterrupted(result)
    if check and status != "success":
        raise ProcessError(result)
    return result


def callable_identity(function: Callable) -> str:
    """Hash a callback's source. Opaque callables require an explicit wrapper."""
    try:
        source = inspect.getsource(function)
    except (OSError, TypeError) as error:
        raise ValueError("benchmark callbacks must have inspectable Python source") from error
    return digest({"name": function.__qualname__, "source": source})


@dataclass(frozen=True)
class Benchmark:
    """Collect one observation with ``run(context) -> named flat tables``.

    ``version`` is the explicit data format/measurement protocol version,
    stored as ``eval_runs.data_version`` and included in cache identity. Bump
    it when the returned tables change shape or meaning. Declare helper
    functions in ``dependencies`` and input paths in ``inputs`` so changes
    invalidate the cache. Relative input paths refer to the benchmarked commit;
    absolute paths refer to external files. ``environment`` records execution
    variables and ``tools`` records toolchain/dependency versions.

    Optional ``build(context) -> Path`` receives ``build_config`` and runs once
    per target/build identity. The resulting binary is ``context.binary`` in
    measurement callbacks. Use ``context.command`` to capture process details.

    Required ``error_rows(treatment, status)`` supplies named flat tables for
    pending, timed-out, failed, or interrupted treatments. It must be pure;
    all templates are validated before collection. Every declared table must
    have rows in both these templates and the collector's successful result.

    ``timeout`` is the optional per-command deadline in seconds (default None),
    overridden by ``--timeout``. Increasing it recollects timeouts while preserving
    successful observations. It does not preempt arbitrary Python callbacks.
    """

    name: str
    run: Callable[[RunContext], Data]
    version: str
    error_rows: Callable[[Mapping, str], Data]
    inputs: Sequence[str | Path] = ()
    dependencies: Sequence[Callable] = ()
    build: Callable[[RunContext], Path] | None = None
    build_config: Mapping = field(default_factory=dict)
    environment: Mapping[str, str] = field(default_factory=dict)
    tools: Mapping = field(default_factory=dict)
    timeout: float | None = None

    def __post_init__(self):
        if (not isinstance(self.name, str) or not self.name or not isinstance(self.version, str)
                or not self.version):
            raise ValueError("benchmark name and version are required")
        if self.timeout is not None and (type(self.timeout) not in (int, float)
                or not math.isfinite(self.timeout) or self.timeout <= 0):
            raise ValueError("timeout must be None or a finite positive number")
        if not callable(self.error_rows):
            raise ValueError("error_rows must be a function returning named flat tables")
        if any(not isinstance(k, str) or not isinstance(v, str) for k, v in self.environment.items()):
            raise ValueError("environment keys and values must be strings")
        for name in ("build_config", "tools", "environment"):
            object.__setattr__(self, name, readonly_parameters(getattr(self, name)))
        object.__setattr__(self, "inputs", tuple(self.inputs))
        object.__setattr__(self, "dependencies", tuple(self.dependencies))

    def identity(self) -> str:
        """Fingerprint measurement and declared helper code independently of plots."""
        return digest({"version": self.version, "run": callable_identity(self.run),
                       "error_rows": callable_identity(self.error_rows),
                       "helpers": [callable_identity(fn) for fn in self.dependencies],
                       "build": callable_identity(self.build) if self.build else None,
                       "build_config": parameters(self.build_config)})

    def fallback(self, config: Mapping, status: str) -> Data:
        """Construct explicit rows for an unfinished or unsuccessful treatment."""
        tables = self.error_rows(readonly_parameters(config), status)
        validate_tables(tables, user=True)
        if not tables or any(not rows for rows in tables.values()):
            raise ValueError("error_rows must supply at least one row in every declared table")
        return tables


@dataclass
class RunContext:
    """Inputs for one callback; commands run in ``directory`` by default."""

    directory: Path
    config: Mapping
    commit: str
    timeout: float | None
    environment: Mapping[str, str]
    binary: Path | None = None
    processes: list[ProcessResult] = field(default_factory=list)

    def __post_init__(self):
        self.config = readonly_parameters(self.config)
        self.environment = readonly_parameters(self.environment)

    def command(self, argv: Sequence[str | Path], *, cwd: str | Path | None = None,
                check: bool = True) -> ProcessResult:
        """Run and record a process using the benchmark's timeout/environment."""
        try:
            result = run_command(argv, cwd=cwd or self.directory, timeout=self.timeout,
                                 env=self.environment, check=False)
        except ProcessInterrupted as error:
            self.processes.append(error.result)
            raise
        self.processes.append(result)
        if check and result.status != "success":
            raise ProcessError(result)
        return result


def file_digest(path: Path) -> str:
    """Hash a file without loading the whole file into memory."""
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()
