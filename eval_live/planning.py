"""Plan from artifact requirements, collect missing observations, then render."""
from __future__ import annotations

from argparse import Namespace
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
import inspect
import math
import os
from pathlib import Path
import platform
import sys
import time
from typing import Mapping, Sequence
import uuid

from .eval_live import Registry, _Output
from .benchmarks import Benchmark, ProcessError, RunContext, file_digest
from .cli import CONTROL_ARGUMENTS
from .render import browser_callbacks, discard_outputs, render_artifacts, report_data
from .store import Store, digest, parameter_rows, parameters, readonly_parameters, run_identity
from .targets import Target, script_revision
from ._workers import Outcome, Worker, completed, ignore_interrupts, measure


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class PlannedRun:
    """One deduplicated treatment and its applicable cached attempt."""

    key: str
    benchmark: Benchmark
    target: Target
    config: dict
    arguments: dict
    environment: dict
    inputs: list[dict]
    config_id: str
    environment_id: str
    runner_id: str
    selected: dict | None = None
    needed_by: list[str] = field(default_factory=list)
    fallback: dict = field(default_factory=dict)


def _replace_rows(store: Store, row: dict, tables: dict) -> None:
    for name in set(tables) | {name for name in store.data if not name.startswith("eval_")}:
        store.data[name] = [item for item in store.data.get(name, []) if item["run_id"] != row["run_id"]]
        store.data[name].extend(dict(item, run_id=row["run_id"]) for item in tables.get(name, []))


@dataclass
class _Attempt:
    """Own one collector's preparation, diagnostics, and temporary checkout.

    The parent prepares and finishes attempts in both execution modes. Its outer
    ExitStack also owns ``checkout`` so failures before finish still release it.
    A worker must stop before its attempt is finished or its checkout is closed.
    """

    planned: PlannedRun
    row: dict
    started: float = field(default_factory=time.perf_counter)
    directory: Path | None = None
    contexts: list[RunContext] = field(default_factory=list)
    checkout: ExitStack = field(default_factory=ExitStack)

    def prepare(self, stack: ExitStack, directories: dict, binaries: dict, *, parallel: bool) -> tuple:
        """Prepare inputs/builds and return the arguments for a collector context."""
        planned = self.planned
        benchmark, target = planned.benchmark, planned.target
        target_key = (target.identity, target.commit, target.working)
        if not target.inputs_match(benchmark.inputs, planned.inputs):
            raise ValueError("declared inputs changed after planning")
        if (not parallel or benchmark.build) and target_key not in directories:
            directories[target_key] = stack.enter_context(target.checkout())
        binary = None
        if benchmark.build:
            build_key = digest([*target_key, parameters(benchmark.build_config), planned.environment_id,
                                planned.runner_id, planned.inputs])
            if build_key not in binaries:
                build_directory = directories[target_key]
                context = RunContext(build_directory, parameters(benchmark.build_config),
                                     target.commit, benchmark.timeout, benchmark.environment)
                self.contexts.append(context)
                binary = Path(benchmark.build(context))
                binary = binary if binary.is_absolute() else build_directory / binary
                if not binary.is_file():
                    raise ValueError("build callback did not produce a file")
                if not target.inputs_match(benchmark.inputs, planned.inputs, build_directory):
                    raise ValueError("declared inputs changed during the build")
                binaries[build_key] = binary
            binary = binaries[build_key]
            self.row["binary_sha256"] = file_digest(binary)
        self.directory = self.checkout.enter_context(target.checkout()) if parallel else directories[target_key]
        if not target.inputs_match(benchmark.inputs, planned.inputs, self.directory):
            raise ValueError("declared inputs changed while preparing the target")
        return (self.directory, planned.config, target.commit, benchmark.timeout, dict(benchmark.environment), binary)

    def finish(self, store: Store, outcome: Outcome) -> None:
        """Checkpoint a completed outcome and release this attempt's checkout."""
        planned, row = self.planned, self.row
        try:
            if outcome.status == "success":
                try:
                    # measure() validates scalar cells in either execution mode.
                    if any(not outcome.tables.get(name) for name in planned.fallback["pending"]):
                        raise ValueError("collector must return rows in every table declared by error_rows")
                    if not planned.target.inputs_match(planned.benchmark.inputs, planned.inputs, self.directory):
                        raise ValueError("declared inputs changed during collection")
                except Exception as error:
                    outcome = Outcome(processes=outcome.processes, status="failure", error=str(error))
            row.update(status=outcome.status, error=outcome.error,
                       finished_at=now(), seconds=time.perf_counter() - self.started)
            tables = outcome.tables if outcome.status == "success" else planned.fallback[outcome.status]
            _replace_rows(store, row, tables)
            processes = [process for context in self.contexts for process in context.processes] + outcome.processes
            for process in processes:
                process_id = str(uuid.uuid4())
                store.data["eval_processes"].append(dict(process_id=process_id, run_id=row["run_id"],
                    cwd=process.cwd, seconds=process.seconds, returncode=process.returncode,
                    stdout=process.stdout, stderr=process.stderr, status=process.status))
                store.data["eval_commands"].extend(dict(process_id=process_id, run_id=row["run_id"],
                    position=i, value=value) for i, value in enumerate(process.argv))
            store.save()
        finally:
            self.checkout.close()


@dataclass
class Plan:
    """Selected outputs, shared treatment runs, and their named dependencies."""

    artifacts: list[_Output]
    runs: dict[str, PlannedRun]
    requirements: dict[str, dict[str, list[str]]]

    @property
    def missing(self) -> int:
        return sum(run.selected is None for run in self.runs.values())

    @property
    def reused(self) -> int:
        return sum(run.selected is not None for run in self.runs.values())

    def describe(self) -> str:
        """Explain required runs, cache hits, and the artifacts needing them."""
        lines = [f"{len(self.artifacts)} artifacts; {self.reused} cached treatments; {self.missing} missing treatments"]
        for run in self.runs.values():
            deadline = "none" if run.benchmark.timeout is None else f"{run.benchmark.timeout:g}s"
            lines.append(f"  {run.benchmark.name}@{run.target.commit[:12]} {run.config!r}: "
                         f"{'cached' if run.selected is not None else 'missing'}; timeout {deadline}; "
                         f"needed by {', '.join(run.needed_by)}")
        return "\n".join(lines)


@dataclass
class EvaluationResult:
    """Outcome, persisted invocation identity, and generated paths."""

    invocation_id: str | None
    data_path: Path
    collected: int
    reused: int
    written: list[Path]
    plan: Plan | None = None


class _Runner:
    """Local collection engine for a Registry; never imported in the browser."""

    def __init__(self, registry: Registry):
        self.declarations = registry._benchmarks
        self.benchmarks = {name: Benchmark(**spec["benchmark"]) for name, spec in self.declarations.items()}
        self.artifacts = registry._outputs
        if not self.artifacts:
            raise ValueError("register at least one graph, table, or macros output")
        ids = [artifact.id.casefold() for artifact in self.artifacts]
        titles = [artifact.title for artifact in self.artifacts]
        if len(set(ids)) != len(ids) or len(set(titles)) != len(titles):
            raise ValueError("output IDs and display names must be unique")
        self.selection_arguments = registry.selection_arguments
        self.browser_source = registry.browser_source
        self.title = registry.title

    @staticmethod
    def _options(args: Namespace | Mapping | None) -> dict:
        supplied = vars(args) if isinstance(args, Namespace) else dict(args or {})
        options = dict(output="out", data=None, only=None, benchmarks=None, force=False,
                       dry_run=False, render_only=False, invocation=None, allow_dirty=False, timeout=None,
                       commit="HEAD", jobs=os.cpu_count() or 1)
        options.update(parameters(supplied))
        if type(options["jobs"]) is not int or options["jobs"] < 1:
            raise ValueError("jobs must be a positive integer")
        timeout = options["timeout"]
        if timeout is not None and (type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0):
            raise ValueError("timeout must be a finite positive number of seconds")
        if options["render_only"] and (options["force"] or options["dry_run"]):
            raise ValueError("--render-only cannot be combined with --force or --dry-run")
        if options["invocation"] and not options["render_only"]:
            raise ValueError("--invocation requires --render-only")
        return options

    def _artifacts(self, options: dict) -> list[_Output]:
        names = options["only"]
        if names is None:
            return self.artifacts
        if not isinstance(names, list) or not names or len(set(names)) != len(names):
            raise ValueError("--only must select distinct artifact IDs")
        by_id = {artifact.id: artifact for artifact in self.artifacts}
        unknown = set(names) - by_id.keys()
        if unknown:
            raise ValueError(f"unknown artifacts: {sorted(unknown)}")
        return [by_id[name] for name in names]

    @staticmethod
    def _data_path(options: dict) -> Path:
        path = Path(options["data"] or Path(options["output"]) / "results.json").expanduser().resolve()
        if path.suffix.lower() != ".json":
            raise ValueError("the data/cache file must have a .json extension")
        return path

    def plan(self, *, args: Namespace | Mapping | None = None) -> Plan:
        """Resolve requirements and inspect the cache without builds or writes."""
        options = self._options(args)
        return self._plan(options, Store(self._data_path(options)))

    def _catalog(self) -> dict[str, Mapping]:
        catalog = {}
        for name, spec in self.declarations.items():
            for raw in spec["treatments"]:
                config = parameters(raw)
                if "benchmark" in config:
                    raise ValueError("benchmark is a reserved treatment field")
                if "parallel" in config and type(config["parallel"]) is not bool:
                    raise ValueError("treatment parallel must be a boolean")
                treatment = {"benchmark": name, "repository": spec["repository"], **config}
                if not isinstance(treatment["repository"], str) or not treatment["repository"]:
                    raise ValueError("treatment repository must be a nonempty string")
                catalog[digest(treatment)] = readonly_parameters(treatment)
        return catalog

    @staticmethod
    def _choose(selector, catalog: dict, label: str, commit: str) -> list[Mapping]:
        def configuration(row):
            return digest({key: value for key, value in row.items() if key != "commit"})

        configurations = {configuration(parameters(row)) for row in catalog.values()}
        selected = {}
        try:
            rows = tuple(catalog.values())
            for row in rows if selector is None else selector(rows):
                requested = parameters(row)
                if configuration(requested) not in configurations:
                    raise ValueError("selector returned a treatment outside the declared catalog")
                requested.setdefault("commit", commit)
                if not isinstance(requested["commit"], str) or not requested["commit"]:
                    raise ValueError("treatment commit must be a nonempty string")
                selected[digest(requested)] = requested
        except Exception as error:
            raise ValueError(f"invalid treatment selection for {label}: {error}") from error
        return list(selected.values())

    def _plan(self, options: dict, store: Store) -> Plan:
        artifacts = self._artifacts(options)
        measurement_args = {key: value for key, value in options.items()
                            if key not in CONTROL_ARGUMENTS and key not in self.selection_arguments}
        allowed = options["benchmarks"]
        if allowed is not None and (not isinstance(allowed, list) or set(allowed) - self.benchmarks.keys()):
            raise ValueError("--benchmarks contains unknown benchmark names")
        plan = Plan(artifacts, {}, {})
        catalog = self._catalog()
        targets = {}
        input_hashes = {}
        runner_ids = {}
        for artifact in artifacts:
            plan.requirements[artifact.id] = {}
            for name, selector in artifact.requires.items():
                requirements = []
                for treatment in self._choose(selector, catalog, f"{artifact.id}/{name}", options["commit"]):
                    benchmark_name = treatment["benchmark"]
                    if allowed is not None and benchmark_name not in allowed:
                        raise ValueError(f"benchmark subset excludes {benchmark_name!r}, required by {artifact.id}")
                    benchmark = self.benchmarks[benchmark_name]
                    if options["timeout"] is not None:
                        benchmark = replace(benchmark, timeout=options["timeout"])
                    target_key = (treatment["repository"], treatment["commit"])
                    if target_key not in targets:
                        targets[target_key] = Target.resolve(*target_key,
                                                             allow_dirty=options["allow_dirty"])
                    target = targets[target_key]
                    input_key = (target.identity, target.commit, target.working, benchmark.inputs)
                    if input_key not in input_hashes:
                        input_hashes[input_key] = target.input_hashes(benchmark.inputs)
                    inputs = input_hashes[input_key]
                    environment = {"python": platform.python_version(), "implementation": platform.python_implementation(),
                                   "platform": platform.platform(), "machine": platform.node(),
                                   "executable": sys.executable,
                                   **{f"env.{key}": value for key, value in benchmark.environment.items()},
                                   **{f"tool.{key}": value for key, value in parameters(benchmark.tools).items()}}
                    config = parameters({key: value for key, value in treatment.items()
                                         if key not in ("benchmark", "repository", "commit")})
                    config_id = digest({"request": config, "arguments": measurement_args,
                                        "build": parameters(benchmark.build_config)})
                    if benchmark_name not in runner_ids:
                        runner_ids[benchmark_name] = benchmark.identity()
                    runner_id = runner_ids[benchmark_name]
                    environment_id = digest(environment)
                    key = digest(run_identity(repository=target.identity, commit=target.commit,
                                              dirty=target.dirty, benchmark=benchmark.name, runner_id=runner_id,
                                              config_id=config_id, inputs=inputs, environment_id=environment_id))
                    if key not in plan.runs:
                        plan.runs[key] = PlannedRun(key, benchmark, target, config, measurement_args,
                                                   environment, inputs, config_id, environment_id,
                                                   runner_id)
                        fallback = {status: benchmark.fallback(config, status)
                                    for status in ("pending", "timed-out", "failure", "interrupted")}
                        if any(set(tables) != set(fallback["pending"]) for tables in fallback.values()):
                            raise ValueError("error_rows must declare the same tables for every status")
                        plan.runs[key].fallback = fallback
                    run = plan.runs[key]
                    reason = f"{artifact.id}/{name}"
                    if reason not in run.needed_by:
                        run.needed_by.append(reason)
                    if not target.dirty and not options["force"]:
                        cached = store.cached(key, timeout=benchmark.timeout)
                        latest = cached[-1] if cached else None
                        run.selected = latest if latest and (latest["status"] == "success" or latest.get("has_rows")) else None
                    if key not in requirements:
                        requirements.append(key)
                plan.requirements[artifact.id][name] = requirements
        return plan

    @contextmanager
    def _invocation(self, store: Store, options: dict, argv: Sequence[str]):
        """Record an invocation and checkpoint its final status, including Ctrl+C."""
        for row in store.data["eval_invocations"]:
            if row["status"] == "running":
                row.update(status="interrupted", finished_at=now())
        for row in store.data["eval_runs"]:
            if row["status"] in ("pending", "running"):
                row.update(status="interrupted", finished_at=now(), error="previous writer stopped before completing this attempt")
        script = self.browser_source if isinstance(self.browser_source, Path) else None
        if script is None:
            filename = inspect.getsourcefile(self.artifacts[0].render)
            script = Path(filename).resolve() if filename else None
        invocation = dict(invocation_id=str(uuid.uuid4()), started_at=now(), finished_at=None,
                          status="running", cwd=str(Path.cwd()), python=platform.python_version(),
                          platform=platform.platform(), **script_revision(script))
        store.data["eval_invocations"].append(invocation)
        store.data["eval_arguments"].extend(parameter_rows(options, invocation_id=invocation["invocation_id"]))
        store.data["eval_argv"].extend(dict(invocation_id=invocation["invocation_id"], position=index, token=token)
                                       for index, token in enumerate(argv))
        store.save()
        try:
            yield invocation
            invocation["status"] = "success"
        except KeyboardInterrupt:
            invocation["status"] = "interrupted"
            raise
        except BaseException:
            invocation["status"] = "failure"
            raise
        finally:
            with ignore_interrupts():
                invocation["finished_at"] = now()
                store.save()

    def _reserve(self, store: Store, plan: Plan, invocation: dict) -> dict:
        """Save every requested treatment's rows before executing any collector."""
        attempts = {}
        configs = {row["config_id"] for row in store.data["eval_configs"]}
        environments = {row["environment_id"] for row in store.data["eval_environments"]}
        for planned in plan.runs.values():
            if planned.selected is not None:
                continue
            if planned.config_id not in configs:
                for scope, values in (("request", planned.config), ("arguments", planned.arguments),
                                      ("build", planned.benchmark.build_config)):
                    store.data["eval_configs"].extend(parameter_rows(values, config_id=planned.config_id, scope=scope))
                configs.add(planned.config_id)
            if planned.environment_id not in environments:
                store.data["eval_environments"].extend(parameter_rows(planned.environment, environment_id=planned.environment_id))
                environments.add(planned.environment_id)
            benchmark, target = planned.benchmark, planned.target
            row = dict(run_id=str(uuid.uuid4()), invocation_id=invocation["invocation_id"],
                       cache_key=planned.key, cacheable=not target.dirty, benchmark=benchmark.name,
                       repository=target.identity, requested_ref=target.ref, commit=target.commit,
                       dirty=target.dirty, runner_id=planned.runner_id, data_version=benchmark.version,
                       config_id=planned.config_id, environment_id=planned.environment_id,
                       timeout=benchmark.timeout, started_at=None, finished_at=None,
                       status="pending", seconds=None, binary_sha256=None, error=None, has_rows=True)
            store.data["eval_runs"].append(row)
            store.data["eval_inputs"].extend(dict(item, run_id=row["run_id"]) for item in planned.inputs)
            _replace_rows(store, row, planned.fallback["pending"])
            planned.selected = row
            attempts[planned.key] = row
        return attempts

    def _collect(self, store: Store, plan: Plan, attempts: dict, *, jobs: int) -> int:
        pending = {}
        with ExitStack() as stack:
            directories = {}
            binaries = {}

            def receive():
                worker = completed(pending)
                outcome = worker.result()
                pending.pop(worker).finish(store, outcome)
                if outcome.status == "interrupted":
                    raise KeyboardInterrupt

            try:
                for planned in plan.runs.values():
                    if planned.key not in attempts:
                        continue
                    parallel = planned.config.get("parallel", False) and jobs > 1
                    # Unmarked treatments are barriers: they run with no other collectors active.
                    while pending and (not parallel or len(pending) >= jobs):
                        receive()
                    benchmark = planned.benchmark
                    row = attempts[planned.key]
                    row.update(status="running", started_at=now())
                    store.save()
                    attempt = _Attempt(planned, row)
                    stack.enter_context(attempt.checkout)
                    try:
                        arguments = attempt.prepare(stack, directories, binaries, parallel=parallel)
                        if parallel:
                            pending[Worker(benchmark.run, arguments)] = attempt
                            continue
                        outcome = measure(benchmark.run, arguments)
                    except KeyboardInterrupt:
                        with ignore_interrupts():
                            attempt.finish(store, Outcome(status="interrupted", error="interrupted by user"))
                        raise
                    except Exception as error:
                        outcome = Outcome(status=error.result.status if isinstance(error, ProcessError) else "failure",
                                          error=str(error))
                    attempt.finish(store, outcome)
                    if outcome.status == "interrupted":
                        raise KeyboardInterrupt
                while pending:
                    receive()
            finally:
                with ignore_interrupts():
                    # Stop every worker before persistence or checkout cleanup can fail.
                    for worker in pending:
                        worker.cancel()
                    outcomes = [(attempt, worker.result()) for worker, attempt in pending.items()]
                    pending.clear()
                    try:
                        for attempt, outcome in outcomes:
                            if outcome.status == "failure":
                                outcome.status = "interrupted"
                            attempt.finish(store, outcome)
                        for planned in plan.runs.values():
                            if planned.key in attempts and attempts[planned.key]["status"] == "pending":
                                row = attempts[planned.key]
                                row.update(status="interrupted", finished_at=now(), error="evaluation stopped before collection")
                                _replace_rows(store, row, planned.fallback["interrupted"])
                        store.save()
                    finally:
                        stack.close()
        return len(attempts)

    @staticmethod
    def _selections(plan: Plan) -> dict:
        return {artifact.id: {
            name: list(dict.fromkeys(plan.runs[key].selected["run_id"] for key in keys))
            for name, keys in plan.requirements[artifact.id].items()
        } for artifact in plan.artifacts}

    @staticmethod
    def _record_selections(store: Store, invocation_id: str, selections: dict) -> None:
        for artifact_id, scopes in selections.items():
            for name, ids in scopes.items():
                store.data["eval_requirements"].append(dict(invocation_id=invocation_id,
                    artifact_id=artifact_id, requirement=name))
                store.data["eval_selections"].extend(dict(invocation_id=invocation_id,
                    artifact_id=artifact_id, requirement=name, position=i, run_id=run_id)
                    for i, run_id in enumerate(ids))
        store.save()

    def _render(self, store, invocation, artifacts, selections, options):
        invocation.update(status="success", finished_at=now(), collection_complete=True)
        data = report_data(store.data, selections, invocation["invocation_id"])
        return render_artifacts(data, artifacts, selections, Path(options["output"]).expanduser(),
                                source=self.browser_source, title=self.title)

    def _render_only(self, store: Store, options: dict, argv: Sequence[str]) -> EvaluationResult:
        """Replay saved selections with matching requirements and data versions.

        Reject incompatible declarations before changing files or recording a new
        invocation. Selectors, Git resolution, and measurement callbacks do not run.
        """
        artifacts = self._artifacts(options)
        saved = options["invocation"]
        if saved is None:
            candidates = [row for row in store.data["eval_invocations"]
                          if row.get("collection_complete", row["status"] == "success")]
            if not candidates:
                raise ValueError("no completed invocation to render")
            saved = candidates[-1]["invocation_id"]
        elif not any(row["invocation_id"] == saved for row in store.data["eval_invocations"]):
            raise ValueError(f"unknown saved invocation: {saved}")
        selections = {}
        runs = {row["run_id"]: row for row in store.data["eval_runs"]}
        for artifact in artifacts:
            rows = [row for row in store.data["eval_selections"]
                    if row["invocation_id"] == saved and row["artifact_id"] == artifact.id]
            names = {row["requirement"] for row in store.data["eval_requirements"]
                     if row["invocation_id"] == saved and row["artifact_id"] == artifact.id}
            if names != set(artifact.requires):
                raise ValueError(f"saved invocation is missing requirements for {artifact.id}")
            selections[artifact.id] = {name: [row["run_id"] for row in sorted(rows, key=lambda r: r["position"])
                                            if row["requirement"] == name] for name in artifact.requires}
            for row in rows:
                run = runs[row["run_id"]]
                benchmark = self.benchmarks.get(run["benchmark"])
                if benchmark is None or benchmark.version != run["data_version"]:
                    raise ValueError(
                        f"saved data version for {run['benchmark']!r} is {run['data_version']!r}; "
                        "declare the matching version to replay it, or run without --render-only to collect current data"
                    )
        discard_outputs(Path(options["output"]).expanduser(), self.artifacts)
        with self._invocation(store, options, argv) as invocation:
            invocation["source_invocation"] = saved
            self._record_selections(store, invocation["invocation_id"], selections)
            written = self._render(store, invocation, artifacts, selections, options)
            return EvaluationResult(invocation["invocation_id"], store.path, 0,
                                    len({run_id for scopes in selections.values() for ids in scopes.values() for run_id in ids}), written)

    def run(self, *, args: Namespace | Mapping | None = None, argv: Sequence[str] | None = None) -> EvaluationResult:
        """Plan, collect, checkpoint, and render the selected paper outputs.

        Default: all artifacts, reusable observations from ``out/results.json``.
        ``--dry-run`` returns a plan without writing. ``--render-only`` uses
        saved sample selections without resolving Git or invoking benchmarks.
        Every requested treatment has rows before collection. Errors/timeouts
        use explicit error rows; renderers decide whether to report messages.
        """
        options = self._options(args)
        # Validate only selected outputs, before collection or changing saved files.
        browser_callbacks(self._artifacts(options), self.browser_source)
        tokens = list(sys.argv[1:] if argv is None else argv)
        store = Store(self._data_path(options))
        if options["dry_run"]:
            plan = self._plan(options, store)
            print(plan.describe())
            return EvaluationResult(None, store.path, 0, plan.reused, [], plan)
        with store.writer():
            if options["render_only"]:
                return self._render_only(store, options, tokens)
            plan = self._plan(options, store)
            print(plan.describe())
            discard_outputs(Path(options["output"]).expanduser(), self.artifacts)
            reused = plan.reused
            with self._invocation(store, options, tokens) as invocation:
                attempts = self._reserve(store, plan, invocation)
                selections = self._selections(plan)
                self._record_selections(store, invocation["invocation_id"], selections)
                collected = self._collect(store, plan, attempts, jobs=options["jobs"])
                written = self._render(store, invocation, plan.artifacts, selections, options)
                return EvaluationResult(invocation["invocation_id"], store.path, collected, reused, written, plan)
