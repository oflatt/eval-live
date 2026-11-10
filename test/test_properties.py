"""Generated contracts for configuration, selection, exports, and persistence."""
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from hypothesis import example, given, settings, strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, rule

import eval_live
from eval_live.eval_live import _scoped_data
from eval_live.render import report_data
from eval_live.store import digest, parameter_rows, read_parameters, run_identity

settings.register_profile("dev", max_examples=100, deadline=None, print_blob=True, derandomize=False)
settings.register_profile("ci", parent=settings.get_profile("dev"), derandomize=True)
settings.register_profile("stress", parent=settings.get_profile("dev"), max_examples=1000)
settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "dev"))

SCALARS = st.one_of(st.none(), st.booleans(), st.integers(-(2**100), 2**100),
                    st.floats(allow_nan=False, allow_infinity=False), st.text(max_size=20))
PARAMETERS = st.dictionaries(st.text(max_size=12), st.one_of(SCALARS, st.lists(SCALARS, max_size=5)), max_size=5)
DEADLINES = st.one_of(st.none(), st.integers(1, 100))
STATUSES = st.sampled_from(["success", "failure", "timed-out", "pending", "running", "interrupted"])
OBSERVATIONS = st.lists(st.tuples(st.integers(0, 1), st.integers(0, 2), SCALARS), max_size=8)


def encoded(value):
    """Compare JSON types too: Python equality equates True, 1, and 1.0."""
    return json.dumps(value, sort_keys=True, allow_nan=False)


def populated_store(path, observations):
    """Build a valid flat cache with independent attempts and shared configurations."""
    store = eval_live.Store(path)
    data = store.data
    environment = {"machine": "generated"}
    environment_id = digest(environment)
    if observations:
        data["eval_environments"] = parameter_rows(environment, environment_id=environment_id)
    configs = set()
    data.update(measurements=[], empty=[])
    for index, (repository, commit, value) in enumerate(observations):
        invocation, run_id, process = f"invocation-{index}", f"run-{index}", f"process-{index}"
        config = {"request": {"value": value}, "arguments": {}, "build": {}}
        config_id = digest(config)
        if config_id not in configs:
            configs.add(config_id)
            for scope, values in config.items():
                data["eval_configs"].extend(parameter_rows(values, config_id=config_id, scope=scope))
        data["eval_invocations"].append({"invocation_id": invocation, "status": "success", "collection_complete": True})
        data["eval_arguments"].extend(parameter_rows({"value": value}, invocation_id=invocation))
        data["eval_argv"].append({"invocation_id": invocation, "position": 0, "token": "--generated"})
        identity = dict(repository=f"/repository-{repository}", commit=f"{commit + 1:040x}",
                        benchmark="generated", data_version="1", config_id=config_id, environment_id=environment_id)
        data["eval_runs"].append(dict(identity, cache_key=digest(run_identity(**identity)), run_id=run_id,
            invocation_id=invocation, requested_ref="HEAD", status="success", seconds=1.0, timeout=None))
        data["measurements"].append({"run_id": run_id, "value": value, "invocation_id": "user column"})
        data["eval_processes"].append({"process_id": process, "run_id": run_id})
        data["eval_commands"].append({"process_id": process, "run_id": run_id, "position": 0, "value": "worker"})
    store.validate()
    return store


class ParameterProperties(unittest.TestCase):
    @given(PARAMETERS, st.data())
    def test_flat_json_roundtrip_preserves_types_and_sequence_order(self, values, choices):
        rows = json.loads(json.dumps(parameter_rows(values), allow_nan=False))
        shuffled = list(choices.draw(st.permutations(rows)))
        self.assertEqual(encoded(read_parameters(shuffled)), encoded(values))
        self.assertEqual(digest(values), digest(dict(reversed(list(values.items())))))

    @given(PARAMETERS)
    def test_duplicate_parameter_positions_are_rejected(self, values):
        rows = parameter_rows(values)
        with self.assertRaises(ValueError):
            read_parameters(rows + [dict(rows[0])])

    @given(PARAMETERS)
    @example({})
    def test_parameter_positions_must_be_integers(self, values):
        rows = parameter_rows(values)
        rows[0]["item_index"] = float(rows[0]["item_index"])
        with self.assertRaises(ValueError):
            read_parameters(rows)

    @given(PARAMETERS, st.sampled_from([(True, 1), (False, 0), (1, 1.0), (None, "None")]))
    def test_cache_identity_distinguishes_scalar_types(self, values, pair):
        self.assertNotEqual(digest({**values, "probe": pair[0]}), digest({**values, "probe": pair[1]}))


class CacheProperties(unittest.TestCase):
    @given(st.lists(st.tuples(st.integers(0, 1), STATUSES, DEADLINES, st.integers(0, 200)), max_size=20),
           st.integers(1, 100), st.integers(1, 100))
    def test_deadline_changes_and_unrelated_attempts_preserve_cache_contract(self, history, smaller, increase):
        with tempfile.TemporaryDirectory() as directory:
            store = eval_live.Store(Path(directory) / "cache.json")
            rows = [dict(run_id=str(i), cache_key=str(key), status=status, timeout=limit, seconds=elapsed)
                    for i, (key, status, limit, elapsed) in enumerate(history)]
            store.data["eval_runs"] = rows
            before = deepcopy(rows)
            short = store.cached("0", timeout=smaller)
            long = store.cached("0", timeout=smaller + increase)
            unlimited = store.cached("0")
            ids = lambda items, status: {r["run_id"] for r in items if r["status"] == status}
            self.assertLessEqual(ids(short, "success"), ids(long, "success"))
            self.assertLessEqual(ids(long, "timed-out"), ids(short, "timed-out"))
            self.assertEqual(ids(short, "failure"), ids(unlimited, "failure"))
            self.assertEqual(unlimited, [r for r in rows if r["cache_key"] == "0" and r["status"] in ("success", "failure")])
            for selected, deadline in ((short, smaller), (long, smaller + increase)):
                self.assertEqual([int(r["run_id"]) for r in selected], sorted(int(r["run_id"]) for r in selected))
                self.assertTrue(all(r["cache_key"] == "0" for r in selected))
                self.assertTrue(all(r["status"] in ("success", "failure", "timed-out") for r in selected))
                self.assertTrue(all(r["timeout"] is not None and deadline <= r["timeout"]
                                    for r in selected if r["status"] == "timed-out"))
                for row in rows:
                    if row["cache_key"] == "0" and row["status"] == "success" and row["seconds"] <= deadline:
                        self.assertIn(row, selected)
            self.assertEqual(rows, before)
            store.data["eval_runs"] = [r for r in rows if r["cache_key"] == "0"]
            self.assertEqual(store.cached("0", timeout=smaller), short)

    @given(OBSERVATIONS, st.data())
    def test_export_is_commit_complete_referentially_valid_and_detached(self, observations, choices):
        with tempfile.TemporaryDirectory() as directory:
            store = populated_store(Path(directory) / "cache.json", observations)
            selected = choices.draw(st.sets(st.integers(0, len(observations) - 1))) if observations else set()
            selections = {"figure": {"data": [f"run-{i}" for i in sorted(selected)]}}
            before = deepcopy(store.data)
            snapshot = report_data(store.data, selections)
            commits = {observations[i][:2] for i in selected}
            expected = {f"run-{i}" for i, row in enumerate(observations) if row[:2] in commits}
            self.assertEqual({r["run_id"] for r in snapshot["eval_runs"]}, expected)
            self.assertEqual({r["run_id"] for r in snapshot["measurements"]}, expected)
            self.assertEqual(snapshot["empty"], [])
            exported = eval_live.Store(Path(directory) / "results.json")
            with exported.writer():
                exported.data = snapshot
                exported.save()
            self.assertEqual(encoded(eval_live.Store(exported.path).data), encoded(snapshot))
            self.assertEqual(report_data(snapshot, selections), snapshot)
            for rows in snapshot.values():
                if rows:
                    rows[0]["changed"] = True
            self.assertEqual(store.data, before)

    @given(OBSERVATIONS, st.data())
    def test_figure_scopes_are_exact_and_do_not_mutate_the_export(self, observations, choices):
        with tempfile.TemporaryDirectory() as directory:
            store = populated_store(Path(directory) / "cache.json", observations)
            indices = st.sets(st.integers(0, len(observations) - 1)) if observations else st.just(set())
            selections = {name: [f"run-{i}" for i in sorted(choices.draw(indices))] for name in ("baseline", "candidate")}
            before = deepcopy(store.data)
            scoped = _scoped_data(store.data, selections)
            union = set(selections["baseline"]) | set(selections["candidate"])
            self.assertEqual({r["run_id"] for r in scoped["measurements"]}, union)
            for name, run_ids in selections.items():
                selected = eval_live.select(scoped, name)
                self.assertEqual({r["run_id"] for r in selected["measurements"]}, set(run_ids))
                self.assertEqual({r["run_id"] for r in selected["eval_runs"]}, set(run_ids))
                self.assertEqual({r["config_id"] for r in selected["eval_configs"]},
                                 {r["config_id"] for r in selected["eval_runs"]})
                self.assertEqual(eval_live.select({**scoped, "measurements": []}, name)["measurements"], [])
                for rows in selected.values():
                    if rows:
                        rows[0]["changed"] = True
            self.assertEqual(store.data, before)


def unused_collector(context):
    raise AssertionError("planning must not collect")


def fallback(treatment, status):
    return {"measurements": [{"status": status}]}


def count_rows(data):
    return [{"count": len(data["measurements"])}]


class PlanningProperties(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repository"
        self.repo.mkdir()
        self.git("init", "-b", "main")
        for value in (1, 2):
            (self.repo / "value").write_text(str(value))
            self.git("add", "value")
            self.git("-c", "user.name=Tests", "-c", "user.email=tests@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", str(value))
        self.commits = {ref: self.git("rev-parse", ref) for ref in ("HEAD", "main", "HEAD~1")}

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], stderr=subprocess.DEVNULL, text=True).strip()

    @given(st.lists(st.tuples(st.sampled_from(["a", "b", "c"]), st.integers(1, 4)), min_size=1, max_size=8),
           st.lists(st.tuples(st.one_of(st.none(), st.sets(st.sampled_from(["a", "b", "c"]))),
                              st.sampled_from([None, "HEAD", "main", "HEAD~1"])), min_size=1, max_size=4),
           st.sampled_from(["HEAD", "HEAD~1"]), st.data())
    def test_planning_matches_set_union_of_selected_treatments(self, catalog, outputs, default, choices):
        reg = eval_live.Registry()
        treatments = [{"suite": suite, "size": size} for suite, size in catalog]
        reg.benchmark("generated", unused_collector, version="1", error_rows=fallback,
                      treatments=treatments, repository=self.repo)
        expected = {}
        for index, (suites, revision) in enumerate(outputs):
            name = f"figure-{index}"
            def required(rows, suites=suites, revision=revision):
                return [{**row, **({"commit": revision} if revision else {})}
                        for row in rows if suites is None or row["suite"] in suites]
            reg.table(name, count_rows, id=name, requires=None if suites is None and revision is None else required)
            expected[name] = {(suite, size, self.commits[revision or default])
                              for suite, size in catalog if suites is None or suite in suites}
        only = sorted(choices.draw(st.sets(st.sampled_from(list(expected)), min_size=1)))
        plan = reg.plan(args={"cache": self.root / "cache.json", "output": self.root / "paper", "only": only, "commit": default})
        actual = {key: (run.config["suite"], run.config["size"], run.target.commit) for key, run in plan.runs.items()}
        self.assertEqual(set(actual.values()), set().union(*(expected[name] for name in only)))
        self.assertEqual(len(actual), len(set(actual.values())))
        for name in only:
            self.assertEqual({actual[key] for key in plan.requirements[name]["data"]}, expected[name])
        self.assertEqual(treatments, [{"suite": suite, "size": size} for suite, size in catalog])
        self.assertFalse((self.root / "cache.json").exists())
        self.assertFalse((self.root / "paper").exists())


class StorePersistence(RuleBasedStateMachine):
    def __init__(self):
        super().__init__()
        self.temporary = tempfile.TemporaryDirectory()
        self.store = populated_store(Path(self.temporary.name) / "cache.json", [(0, 0, 0)])
        initial = self.store.data
        with self.store.writer():
            self.store.data = initial
            self.store.save()
        self.model = deepcopy(initial)

    @rule(value=SCALARS, external=st.booleans())
    def save(self, value, external):
        store = eval_live.Store(self.store.path) if external else self.store
        row = {"run_id": "run-0", "value": value}
        with store.writer():
            store.data["measurements"].append(row)
            store.save()
        self.model["measurements"].append(dict(row))

    @rule(value=SCALARS, operation=st.sampled_from(["fsync", "replace"]), interrupted=st.booleans())
    def failed_save(self, value, operation, interrupted):
        before = self.store.path.read_bytes()
        error = KeyboardInterrupt if interrupted else OSError
        try:
            with self.store.writer():
                self.store.data["measurements"].append({"run_id": "run-0", "value": value})
                with patch(f"eval_live.store.os.{operation}", side_effect=error):
                    self.store.save()
        except error:
            pass
        else:
            raise AssertionError("injected write failure was ignored")
        assert self.store.path.read_bytes() == before
        assert not list(self.store.path.parent.glob(".cache.json.*"))

    @rule(value=SCALARS)
    def discard_unsaved_changes(self, value):
        with self.store.writer():
            self.store.data["measurements"].append({"run_id": "run-0", "value": value})

    @rule()
    def reload(self):
        self.store.reload()
        assert encoded(self.store.data) == encoded(self.model)

    @invariant()
    def disk_contains_exactly_the_committed_rows(self):
        assert encoded(eval_live.Store(self.store.path).data) == encoded(self.model)

    def teardown(self):
        self.temporary.cleanup()


TestStorePersistence = StorePersistence.TestCase
TestStorePersistence.settings = settings(max_examples=max(1, settings.default.max_examples // 4), stateful_step_count=25)

if __name__ == "__main__":
    unittest.main()
