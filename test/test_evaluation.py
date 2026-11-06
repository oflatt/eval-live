"""Integration checks for provenance, caching, Git isolation, and artifact plans.

Run: python -m unittest discover -s test -p 'test_evaluation.py'
"""
import argparse
from contextlib import redirect_stderr
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import ModuleType
import unittest
from unittest.mock import patch

import eval_live
from eval_live.benchmarks import ProcessInterrupted, ProcessResult
from eval_live.store import atomic_write, digest, parameter_rows, read_parameters

CALLS = []
BUILDS = []


def error_rows(treatment, status):
    return {"measurements": [{"value": None, "factor": treatment.get("factor", 1),
                               "sample": treatment.get("sample", 0), "status": status}]}


def collect(context):
    CALLS.append((context.commit, {k: v for k, v in context.config.items() if k != "sample"}, context.config.get("sample", 0)))
    if context.config.get("fail"):
        context.command([sys.executable, "-c", "import sys; print('diagnostic'); sys.exit(7)"])
    value = int((context.directory / "value.txt").read_text())
    return {"measurements": [{"value": value, "factor": context.config.get("factor", 1),
                               "sample": context.config.get("sample", 0)}]}


def logged_collect(context):
    context.command([sys.executable, "-c", "print('measurement log')"])
    return collect(context)


def slow(context):
    context.command([sys.executable, "-c", "import time; time.sleep(30)"])
    return {}


def timed_collect(context):
    CALLS.append((context.commit, {k: v for k, v in context.config.items() if k != "sample"}, context.config.get("sample", 0)))
    if context.config.get("delayed") or (context.config.get("after_first") and context.config.get("sample", 0) > 0):
        context.command([sys.executable, "-c", "import time; time.sleep(0.1)"])
    return {"measurements": [{"value": 20, "sample": context.config.get("sample", 0)}]}


def concurrent_collect(context):
    started = time.monotonic()
    token = context.config["case"]
    scratch = context.directory / "scratch"
    scratch.write_text(token)
    if context.config.get("rendezvous"):
        barrier = Path(context.config["rendezvous"])
        (barrier / token).touch()
        while len(list(barrier.iterdir())) < 2:
            if time.monotonic() - started > 10:
                raise RuntimeError("collectors did not overlap")
            time.sleep(0.01)
    time.sleep(0.15)
    assert scratch.read_text() == token, "concurrent collectors shared a worktree"
    return {"measurements": [{"value": 20, "case": token, "pid": os.getpid(),
                               "started": started, "finished": time.monotonic()}]}


def stubborn_collect(context):
    import signal
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    (Path(context.config["pids"]) / context.config["case"]).write_text(str(os.getpid()))
    while True:
        time.sleep(0.05)


def collect_directory(context):
    context.command([sys.executable, "-c", "import src.worker; print(src.worker.VALUE)"])
    return collect(context)


def interrupted_collect(context):
    context.command([sys.executable, "-c",
                     "import os, pathlib, sys, time; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); "
                     "print('started', flush=True); time.sleep(30)",
                     str(Path(context.config["pids"]) / context.config["case"])])
    return {}


def build(context):
    BUILDS.append(context.commit)
    path = context.directory / "binary"
    path.write_text("built")
    return path


def use_binary(context):
    assert context.binary.read_text() == "built"
    return {"measurements": [{"value": context.config["value"]}]}


def invalid(context):
    return {"measurements": [{"nested": [1, 2]}]}


def mutate_input(context):
    (context.directory / "value.txt").write_text("changed")
    return {"measurements": [{"value": 99}]}


def table(data):
    assert type(data) is dict
    return [{"value": row["value"], "sample": row.get("sample", 0)}
            for row in data["measurements"]]


def comparison(data):
    return [{"baseline": eval_live.select(data, "baseline")["measurements"][0]["value"],
             "candidate": eval_live.select(data, "candidate")["measurements"][0]["value"]}]


def macros(data):
    return {"PaperCount": len(data["measurements"]), "PaperLabel": "x_y & z"}


def figure(data):
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots()
    ax.plot([row["value"] for row in data["measurements"]])
    return fig


def constant_table(data):
    return [{"message": "No benchmark required"}]


def empty_named_table(data):
    return [{"count": len(eval_live.select(data, "empty").get("measurements", []))}]


def check_reserved(context):
    saved = json.loads(Path(context.config["data"]).read_text())
    assert len(saved["measurements"]) == 3
    assert len(saved["eval_selections"]) == 3
    assert {row["run_id"] for row in saved["measurements"]} == {row["run_id"] for row in saved["eval_runs"]}
    if context.config["sample"] == 0:
        assert [row["status"] for row in saved["measurements"]] == ["pending"] * 3
    return {"measurements": [{"value": 1, "sample": context.config["sample"]}]}


def empty_result(context):
    return {}


def report_messages(data):
    eval_live.error("Results need review")
    eval_live.warn("Some values are missing")
    eval_live.warn("Some values are missing")
    return table(data)


def conditional_messages(data):
    if data.get("problem"):
        eval_live.warn("Some values are missing")
    return []


def broken_figure(data):
    raise ValueError("invalid figure input")


RENDER_CALLS = []


def counted_table(data):
    RENDER_CALLS.append("table")
    return [{"calls": len(RENDER_CALLS)}]


def transient_failure(data):
    RENDER_CALLS.append("failure")
    if len(RENDER_CALLS) == 1:
        raise ValueError("first calculation failed")
    return [{"calls": len(RENDER_CALLS)}]


def omitted_figure(data):
    return None


def interrupted_figure(data):
    raise KeyboardInterrupt


def large_measurement(context):
    return {"measurements": [{"value": 2**53 + 1}]}


class EvaluationTests(unittest.TestCase):
    def setUp(self):
        CALLS.clear()
        BUILDS.clear()
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-b", "main")
        self.commit_value(10)
        self.old = self.git("rev-parse", "HEAD")
        self.commit_value(20)
        self.head = self.git("rev-parse", "HEAD")
        self.output = self.root / "output"
        self.data = self.output / "results.json"
        self.treatments = []

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], stderr=subprocess.DEVNULL, text=True).strip()

    def commit_value(self, value):
        (self.repo / "value.txt").write_text(str(value))
        self.git("add", "value.txt")
        self.git("-c", "user.name=Tests", "-c", "user.email=tests@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", str(value))

    def request(self, *, samples=1, commit=None, **config):
        # Repetitions belong to the paper: each sample is an ordinary treatment.
        self.treatments.extend({**config, "sample": i} for i in range(samples))

        def needed(treatments):
            return [{**t, **({"commit": commit} if commit is not None else {})}
                    for t in treatments if t["sample"] < samples
                    and {k: v for k, v in t.items() if k not in ("benchmark", "repository", "commit", "sample")} == config]

        return needed

    def evaluation(self, request=None, registry=None, benchmark=None, **kwargs):
        if registry is None:
            registry = eval_live.Registry(**kwargs)
            registry.table("values", table, requires=request or self.request(), id='values')
        options = vars(benchmark or eval_live.Benchmark("read", collect, "1", inputs=["value.txt"], error_rows=error_rows)).copy()
        options["fn"] = options.pop("run")
        registry.benchmark(**options, treatments=self.treatments, repository=self.repo)
        return registry

    def run_eval(self, evaluation=None, *, render=False, **options):
        args = dict(output=self.output, data=self.data, **options)
        evaluation = evaluation or self.evaluation()
        if render:
            return evaluation.run(args=args, argv=["--test"])
        with patch("eval_live.planning.render_artifacts", return_value=[]):
            return evaluation.run(args=args, argv=["--test"])

    def stored(self):
        return eval_live.Store(self.data).data

    def parallel_registry(self, treatments, callback=concurrent_collect, **options):
        reg = eval_live.Registry()
        reg.benchmark("read", callback, version="1", repository=self.repo,
                      inputs=["value.txt"], treatments=treatments, error_rows=error_rows, **options)
        reg.table("Values", table, id='values')
        return reg

    def test_parallel_workers_overlap_obey_limit_and_isolate_serial_treatments(self):
        barrier = self.root / "barrier"
        barrier.mkdir()
        treatments = [{"case": str(i), "parallel": i != 3,
                       **({"rendezvous": str(barrier)} if i < 2 else {})} for i in range(6)]
        reg = self.parallel_registry(treatments)
        self.assertEqual(self.run_eval(reg, jobs=2).collected, 6)
        rows = sorted(self.stored()["measurements"], key=lambda row: row["case"])
        self.assertLess(max(r["started"] for r in rows[:2]), min(r["finished"] for r in rows[:2]))
        self.assertTrue(all(r["pid"] != os.getpid() for r in rows if r["case"] != "3"))
        self.assertEqual(rows[3]["pid"], os.getpid())
        self.assertLessEqual(max(r["finished"] for r in rows[:3]), rows[3]["started"])
        self.assertLessEqual(rows[3]["finished"], min(r["started"] for r in rows[4:]))
        events = sorted([(r["started"], 1) for r in rows] + [(r["finished"], -1) for r in rows])
        active = 0
        for _, delta in events:
            active += delta
            self.assertLessEqual(active, 2)
        self.assertEqual(self.run_eval(reg, jobs=2).reused, 6)
        self.assertEqual(len(self.git("worktree", "list", "--porcelain").split("worktree ")) - 1, 1)

    def test_unmarked_treatments_and_jobs_one_run_sequentially(self):
        for parallel, jobs in ((False, 3), (True, 1)):
            treatments = [{"case": str(i), **({"parallel": True} if parallel else {})} for i in range(3)]
            self.run_eval(self.parallel_registry(treatments), jobs=jobs)
            rows = self.stored()["measurements"][-3:]
            self.assertTrue(all(r["pid"] == os.getpid() for r in rows))
            self.assertTrue(all(a["finished"] <= b["started"] for a, b in zip(rows, rows[1:])))

    def test_parallel_default_jobs_validation_and_configuration_identity(self):
        with patch("os.cpu_count", return_value=2):
            parser = eval_live.add_arguments(argparse.ArgumentParser())
            self.assertEqual(parser.parse_args([]).jobs, 2)
            reg = self.parallel_registry([{"case": "a", "parallel": True}], callback=collect)
            self.assertEqual(self.run_eval(reg).collected, 1)
            self.assertEqual(self.run_eval(reg, jobs=2).reused, 1)
            self.assertEqual(self.run_eval(reg, jobs=1).collected, 1)
            other = self.parallel_registry([{"case": "a", "parallel": False}], callback=collect)
            self.assertEqual(self.run_eval(other, jobs=1).collected, 1)
        for jobs in (0, -1, True, 1.5, "2", None):
            with self.assertRaisesRegex(ValueError, "jobs"):
                self.run_eval(reg, jobs=jobs)
        for flag in (1, "true", None):
            with self.assertRaisesRegex(ValueError, "parallel"):
                self.run_eval(self.parallel_registry([{"parallel": flag}]))

    def test_parallel_timeout_retries_only_timed_out_treatments(self):
        reg = self.parallel_registry([{"parallel": True, "delayed": delayed} for delayed in (False, True)],
                                     callback=timed_collect)
        self.run_eval(reg, jobs=2, timeout=0.01)
        result = self.run_eval(reg, jobs=2, timeout=5)
        self.assertEqual((result.collected, result.reused), (1, 1))
        self.assertEqual(len(self.stored()["eval_runs"]), 3)
        self.assertEqual([p["status"] for p in self.stored()["eval_processes"]], ["timed-out", "success"])

    def test_parallel_builds_share_work_and_failures_keep_diagnostics(self):
        reg = self.parallel_registry([{"parallel": True, "value": i} for i in range(3)],
                                     callback=use_binary, build=build)
        self.assertEqual(self.run_eval(reg, jobs=2).collected, 3)
        self.assertEqual(len(BUILDS), 1)
        reg = self.parallel_registry([{"parallel": True, "fail": fail} for fail in (True, False)], callback=collect)
        self.run_eval(reg, jobs=2)
        self.assertEqual(self.stored()["eval_processes"][-1]["returncode"], 7)
        self.assertIn("diagnostic", self.stored()["eval_processes"][-1]["stdout"])
        self.assertEqual(len(self.stored()["measurements"]), 5)

    @unittest.skipUnless(os.name == "posix", "POSIX signal and process-group behavior")
    def test_parallel_interrupt_stops_commands_and_checkpoints_attempts(self):
        self.check_parallel_interrupt("interrupted_collect")

    @unittest.skipUnless(os.name == "posix", "POSIX signal behavior")
    def test_repeated_interrupt_kills_stubborn_workers_and_removes_worktrees(self):
        self.check_parallel_interrupt("stubborn_collect", repeated=True)

    def check_parallel_interrupt(self, collector, repeated=False):
        import signal
        before = self.git("worktree", "list", "--porcelain")
        pids = self.root / "pids"
        pids.mkdir()
        script = self.root / "interrupt.py"
        script.write_text(
            "import sys\n"
            f"sys.path.insert(0, {str(Path(__file__).parent)!r})\n"
            f"import eval_live\nfrom test_evaluation import {collector}, constant_table, error_rows\n"
            "if __name__ == '__main__':\n"
            "    reg = eval_live.Registry()\n"
            f"    reg.benchmark('slow', {collector}, version='1', error_rows=error_rows, repository={str(self.repo)!r}, "
            f"treatments=[{{'case': str(i), 'parallel': True, 'pids': {str(pids)!r}}} for i in range(4)])\n"
            "    reg.table('Counts', constant_table)\n"
            f"    reg.run(args={{'output': {str(self.output)!r}, 'jobs': 2}})\n"
        )
        with subprocess.Popen([sys.executable, str(script)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as process:
            try:
                deadline = time.monotonic() + 15
                while len(list(pids.iterdir())) < 2 and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertEqual(len(list(pids.iterdir())), 2, "workers did not start")
                process.send_signal(signal.SIGINT)
                if repeated:
                    time.sleep(0.15)
                    process.send_signal(signal.SIGINT)
                _, stderr = process.communicate(timeout=10)
                self.assertIn("KeyboardInterrupt", stderr)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()
        data = self.stored()
        self.assertEqual([r["status"] for r in data["eval_runs"]], ["interrupted"] * 4)
        self.assertEqual(len(data["measurements"]), 4)
        self.assertEqual({r["status"] for r in data["measurements"]}, {"interrupted"})
        self.assertFalse((self.output / "index.html").exists())
        self.assertEqual([r["status"] for r in data["eval_processes"]], [] if repeated else ["interrupted", "interrupted"])
        self.assertEqual(data["eval_invocations"][0]["status"], "interrupted")
        self.assertEqual(self.git("worktree", "list", "--porcelain"), before)
        self.assertTrue(all(not Path(row["cwd"]).exists() for row in data["eval_processes"]))
        for path in pids.iterdir():
            with self.assertRaises(ProcessLookupError):
                os.kill(int(path.read_text()), 0)

    def test_decorator_registration_preserves_functions_and_direct_registration(self):
        reg = eval_live.Registry()
        self.assertIs(reg.benchmark("read", version="1", repository=self.repo, error_rows=error_rows)(collect), collect)
        self.assertIs(reg.table("Values", id='values')(table), table)
        self.assertIs(reg.graph("Figure")(figure), figure)
        self.assertIs(reg.macros("Numbers")(macros), macros)
        self.assertIs(reg.table("Other", constant_table, id='other'), constant_table)
        result = self.run_eval(reg)
        self.assertEqual(result.collected, 1)
        self.assertEqual(len(reg._outputs), 4)

    def test_all_rows_and_selections_exist_before_collection_starts(self):
        reg = self.evaluation(self.request(samples=3, data=str(self.data)),
                              benchmark=eval_live.Benchmark("read", check_reserved, "1", error_rows=error_rows))
        self.assertEqual(self.run_eval(reg).collected, 3)
        self.assertEqual(len(self.stored()["measurements"]), 3)
        self.assertEqual({r["value"] for r in self.stored()["measurements"]}, {1})

    def test_empty_results_use_error_rows_and_timeouts_are_disabled_by_default(self):
        reg = self.evaluation(benchmark=eval_live.Benchmark("read", empty_result, "1", error_rows=error_rows))
        captured = io.StringIO()
        with redirect_stderr(captured):
            result = self.run_eval(reg, render=True)
        self.assertEqual(result.collected, 1)
        self.assertEqual(self.stored()["measurements"][0]["status"], "failure")
        self.assertIsNone(self.stored()["eval_runs"][0]["timeout"])
        self.assertNotIn("WARNING:", captured.getvalue())
        self.assertNotIn("ERROR:", captured.getvalue())
        self.assertTrue((self.output / "values.tex").exists())
        self.assertEqual(self.run_eval(reg).reused, 1)
        self.assertEqual(eval_live.run_command([sys.executable, "-c", "print('unlimited')"]).stdout, "unlimited\n")

    def test_removing_timeout_recollects_timeouts_and_reuses_successes(self):
        reg = self.evaluation(self.request(after_first=True, samples=2),
                              benchmark=eval_live.Benchmark("read", timed_collect, "1", error_rows=error_rows))
        self.run_eval(reg, timeout=0.01)
        result = self.run_eval(reg)
        self.assertEqual((result.collected, result.reused), (1, 1))
        self.assertEqual([r["status"] for r in self.stored()["eval_runs"]], ["success", "timed-out", "success"])
        self.assertIsNone(self.stored()["eval_runs"][-1]["timeout"])

    def test_error_rows_are_required_and_validated_before_writing(self):
        reg = eval_live.Registry()
        with self.assertRaises(TypeError):
            reg.benchmark("read", collect, version="1")
        for invalid_rows in ({}, {"measurements": []}, {"measurements": [{"value": [1]}]}):
            def fallback(treatment, status):
                return invalid_rows
            candidate = self.evaluation(benchmark=eval_live.Benchmark("read", collect, "1", error_rows=fallback))
            with self.assertRaises(ValueError):
                self.run_eval(candidate)
        self.assertFalse(self.data.exists())
        self.assertEqual(CALLS, [])

    def test_computed_messages_are_live_deduplicated_ordered_and_never_stored(self):
        reg = eval_live.Registry()
        reg.table("First", report_messages, id='first')
        reg.table("Second", report_messages, id='second')
        self.request()
        evaluation = self.evaluation(registry=reg)
        captured = io.StringIO()
        with redirect_stderr(captured), self.assertRaisesRegex(RuntimeError, "rendering reported errors"):
            self.run_eval(evaluation, render=True)
        output = captured.getvalue()
        self.assertEqual(output.count("WARNING: Some values are missing"), 1)
        self.assertEqual(output.count("ERROR: Results need review"), 1)
        self.assertLess(output.index("ERROR:"), output.index("Warnings:"))
        self.assertLess(output.index("Warnings:"), output.index("Errors:"))
        self.assertEqual(output.count("Some values are missing"), 2)
        self.assertEqual(output.count("Results need review"), 2)
        self.assertNotIn("Some values are missing", self.data.read_text())
        self.assertNotIn("Results need review", self.data.read_text())
        self.assertFalse((self.output / "first.tex").exists())
        self.assertFalse((self.output / "second.tex").exists())
        saved_rows = self.stored()["measurements"]
        with redirect_stderr(io.StringIO()), self.assertRaisesRegex(RuntimeError, "rendering reported errors"):
            self.run_eval(evaluation, render=True, render_only=True)
        self.assertEqual(saved_rows, self.stored()["measurements"])
        self.assertEqual(len(self.stored()["eval_runs"]), 1)

    def test_browser_messages_recompute_and_do_not_mutate_supplied_data(self):
        reg = eval_live.Registry()
        reg.table("One", conditional_messages, id='one')
        reg.table("Two", conditional_messages, id='two')
        data = {"problem": True}
        reg.run_tables(data)
        self.assertEqual(reg.run_messages()[0]["rows"], [{"message": "Some values are missing"}])
        self.assertEqual(data, {"problem": True})
        reg.run_tables({})
        self.assertEqual(reg.run_messages()[0]["rows"], [])

    def test_figure_exceptions_report_errors_and_other_outputs_still_render(self):
        reg = eval_live.Registry()
        reg.table("Broken", broken_figure, id='broken')
        reg.table("Working", table, id='working')
        self.request()
        with redirect_stderr(io.StringIO()) as captured, self.assertRaisesRegex(RuntimeError, "rendering reported errors"):
            self.run_eval(self.evaluation(registry=reg), render=True)
        self.assertIn("ERROR: Broken: invalid figure input", captured.getvalue())
        self.assertFalse((self.output / "working.tex").exists())
        self.assertEqual(len(self.stored()["measurements"]), 1)

    def test_replay_rejects_incompatible_or_missing_benchmark_version(self):
        reg = self.evaluation()
        original = self.run_eval(reg, render=True)
        reg._benchmarks["read"]["benchmark"]["version"] = "seconds"
        with self.assertRaisesRegex(ValueError, "saved data version"):
            self.run_eval(reg, render=True, render_only=True)
        self.assertEqual(self.stored()["eval_invocations"][-1]["invocation_id"], original.invocation_id)
        del reg._benchmarks["read"]
        with self.assertRaisesRegex(ValueError, "saved data version"):
            self.run_eval(reg, render=True, render_only=True)

    def test_table_is_evaluated_once_for_files_and_console_on_every_run(self):
        RENDER_CALLS.clear()
        reg = eval_live.Registry()
        reg.table("Counted", counted_table, id="counted")
        for expected in (1, 2):
            self.run_eval(reg, render=True)
            self.assertEqual(len(RENDER_CALLS), expected)
            self.assertIn(str(expected), (self.output / "counted.tex").read_text())

    def test_transient_render_error_cannot_be_erased_by_console_output(self):
        RENDER_CALLS.clear()
        reg = eval_live.Registry()
        reg.table("Flaky", transient_failure, id="flaky")
        with redirect_stderr(io.StringIO()), self.assertRaisesRegex(RuntimeError, "rendering reported errors"):
            self.run_eval(reg, render=True)
        self.assertEqual(len(RENDER_CALLS), 1)
        self.assertEqual(self.stored()["eval_invocations"][-1]["status"], "failure")
        self.assertFalse((self.output / "flaky.tex").exists())
        self.assertFalse((self.output / "index.html").exists())

    def test_omitted_or_removed_outputs_never_leave_old_files(self):
        reg = self.evaluation()
        reg.graph("Plot", figure, id="plot")
        self.run_eval(reg, render=True)
        self.assertTrue((self.output / "plot.pdf").exists())
        (self.output / "notes.txt").write_text("keep")
        reg = self.evaluation()
        reg.graph("Plot", omitted_figure, id="plot")
        self.run_eval(reg, render=True)
        self.assertFalse((self.output / "plot.pdf").exists())
        self.run_eval(reg, render=True, only=["plot"])
        self.assertFalse((self.output / "values.tex").exists())
        self.assertEqual((self.output / "notes.txt").read_text(), "keep")
        self.assertTrue(self.data.exists())

    def test_dry_run_preserves_outputs_and_collection_interrupt_removes_them(self):
        reg = self.evaluation()
        self.run_eval(reg, render=True)
        before = {path.name: path.read_bytes() for path in self.output.iterdir() if path.is_file()}
        self.run_eval(reg, dry_run=True)
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.output.iterdir() if path.is_file()})
        with patch("eval_live.planning._Runner._collect", side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
            self.run_eval(reg, render=True, force=True)
        self.assertFalse((self.output / "values.tex").exists())
        self.assertFalse((self.output / "index.html").exists())
        self.assertTrue(self.data.exists())

    def test_interrupt_during_render_or_publication_removes_all_artifacts(self):
        for during_publish in (False, True):
            reg = self.evaluation()
            reg.graph("Plot", figure, id="plot")
            self.run_eval(reg, render=True)
            if during_publish:
                replace = Path.replace
                def interrupt(path, target):
                    if path.name == "plot.pdf":
                        raise KeyboardInterrupt
                    return replace(path, target)
                with patch.object(Path, "replace", interrupt), self.assertRaises(KeyboardInterrupt):
                    self.run_eval(reg, render=True)
            else:
                reg = self.evaluation()
                reg.graph("Plot", interrupted_figure, id="plot")
                with self.assertRaises(KeyboardInterrupt):
                    self.run_eval(reg, render=True)
            self.assertEqual(list(self.output.glob("*.pdf")), [])
            self.assertEqual(list(self.output.glob("*.tex")), [])
            self.assertFalse((self.output / "index.html").exists())
            self.assertTrue(self.data.exists())

    def test_browser_rejects_unsafe_integers_without_corrupting_saved_data(self):
        from eval_live.render import write_html
        reg = self.evaluation()
        self.run_eval(reg)
        for value in (2**53, -(2**53), 2**53 + 1):
            with self.assertRaisesRegex(ValueError, "browser's exact range"):
                write_html(self.output / "large.html", {"samples": [{"value": value}]},
                           reg._outputs, {"values": {"data": []}})
        self.assertFalse((self.output / "large.html").exists())
        for value in (2**53 - 1, str(2**53 + 1)):
            write_html(self.output / "large.html", {"samples": [{"value": value}]},
                       reg._outputs, {"values": {"data": []}})
        reg._benchmarks["read"]["benchmark"]["run"] = large_measurement
        with self.assertRaisesRegex(ValueError, "browser's exact range"):
            self.run_eval(reg, render=True)
        self.assertEqual(self.stored()["measurements"][-1]["value"], 2**53 + 1)
        self.assertFalse((self.output / "values.tex").exists())
        self.assertFalse((self.output / "index.html").exists())

    def test_cache_hits_do_not_collect_or_checkout(self):
        first = self.run_eval()
        self.assertEqual((first.collected, first.reused), (1, 0))
        with patch("eval_live.targets.Target.checkout", side_effect=AssertionError("cache hit must not check out")):
            second = self.run_eval()
        self.assertEqual((second.collected, second.reused), (0, 1))
        self.assertEqual(len(CALLS), 1)
        self.assertEqual(len(self.stored()["eval_invocations"]), 2)
        self.assertEqual(self.stored()["eval_argv"][0]["token"], "--test")

    def test_sample_count_cli_argument_is_part_of_configuration_identity(self):
        two = self.evaluation(self.request(samples=2))
        self.assertEqual(self.run_eval(two, samples=2).collected, 2)
        self.assertEqual(self.run_eval(two, samples=2).reused, 2)
        three = self.evaluation(self.request(samples=3))
        result = self.run_eval(three, samples=3)
        self.assertEqual((result.collected, result.reused), (3, 0))
        self.assertEqual(self.run_eval(two, samples=2).reused, 2)
        self.assertEqual(len(self.stored()["eval_runs"]), 5)

    def test_no_selector_runs_entire_catalog_and_duplicates_share_work(self):
        reg = eval_live.Registry()
        reg.benchmark("read", collect, version="1", repository=self.repo,
                      treatments=[{"suite": "a"}, {"suite": "b"}, {"suite": "a"}], error_rows=error_rows)
        reg.table("All", table, id='all')
        reg.macros("Numbers", macros)
        result = self.run_eval(reg)
        self.assertEqual(result.collected, 2)
        self.assertEqual(len(self.stored()["eval_selections"]), 4)
        self.assertEqual(self.run_eval(reg).reused, 2)

    def test_requested_commits_default_override_and_share_observations(self):
        reg = eval_live.Registry()
        reg.benchmark("read", collect, version="1", repository=self.repo,
                      treatments=[{"sample": 0}, {"sample": 1}], error_rows=error_rows)
        seen = []

        def history(treatments):
            seen.extend(dict(t) for t in treatments)
            treatment = next(t for t in treatments if t["sample"] == 0)
            return [treatment, {**treatment, "commit": "HEAD"},
                    {**treatment, "commit": self.head}, {**treatment, "commit": self.old}]

        reg.table("Current", table, id="current")
        reg.table("History", table, requires=history, id="history")
        plan = reg.plan(args={"output": self.output})
        self.assertEqual(len(plan.runs), 3)
        current = plan.requirements["current"]["data"]
        comparison = plan.requirements["history"]["data"]
        self.assertEqual(len(current), 2)
        self.assertEqual({plan.runs[key].target.commit for key in current}, {self.head})
        self.assertEqual(len(comparison), 2)
        self.assertEqual({plan.runs[key].target.commit for key in comparison}, {self.head, self.old})
        self.assertEqual(len(set(current) & set(comparison)), 1)
        self.assertEqual(self.run_eval(reg).collected, 3)
        self.assertTrue(all("commit" not in t for t in seen))
        self.assertEqual({row["name"] for row in self.stored()["eval_configs"]
                          if row["scope"] == "request"}, {"sample"})

        result = self.run_eval(reg, only=["current"], commit=self.old)
        self.assertEqual((result.collected, result.reused), (1, 1))
        replay = self.run_eval(reg)
        self.assertEqual((replay.collected, replay.reused), (0, 3))

    def test_selector_can_remove_declared_commit_to_use_cli_default(self):
        reg = eval_live.Registry()
        reg.benchmark("read", collect, version="1", repository=self.repo,
                      treatments=[{"sample": 0, "commit": self.old}], error_rows=error_rows)
        reg.table("Pinned", table, id="pinned")
        reg.table("Default", table, requires=lambda ts: [
            {key: value for key, value in treatment.items() if key != "commit"} for treatment in ts
        ], id="default")
        plan = reg.plan(args={"output": self.output})
        self.assertEqual(len(plan.runs), 2)
        for output, commit in (("pinned", self.old), ("default", self.head)):
            key, = plan.requirements[output]["data"]
            self.assertEqual(plan.runs[key].target.commit, commit)
        self.assertFalse(self.output.exists())

    def test_python_selectors_filter_catalog_before_resolving_targets(self):
        reg = eval_live.Registry()
        reg.benchmark("read", collect, version="1", repository=self.repo, treatments=[
            {"suite": suite, "size": size, "commit": "missing-ref" if suite == "c" else "HEAD"}
            for suite in ("a", "b", "c") for size in (10, 20)
        ], error_rows=error_rows)

        def needed(treatments):
            return (dict(t) for t in treatments if t["suite"] in {"a", "b"})

        def unselected(treatments):
            raise AssertionError("unselected output must not evaluate its selector")

        reg.table("Selected", table, requires=needed, id='selected')
        reg.table("Other", table, requires=unselected, id='other')
        result = self.run_eval(reg, only=["selected"])
        self.assertEqual(result.collected, 4)
        self.assertEqual({config["size"] for _, config, _ in CALLS}, {10, 20})
        self.assertEqual({config["suite"] for _, config, _ in CALLS}, {"a", "b"})

    def test_selectors_cannot_mutate_or_invent_treatments(self):
        def mutate(treatments):
            treatments[0]["size"] = 99
            return treatments

        selectors = [mutate, lambda ts: [{**ts[0], "size": 99}], lambda ts: None]
        selectors.extend(lambda ts, commit=commit: [{**ts[0], "commit": commit}]
                         for commit in (None, "", 123, ["HEAD"]))
        for selector in selectors:
            reg = eval_live.Registry()
            reg.benchmark("read", collect, version="1", repository=self.repo, treatments=[{"size": 10}], error_rows=error_rows)
            reg.table("Invalid", table, requires=selector, id='invalid')
            with self.assertRaisesRegex(ValueError, "invalid treatment selection for invalid/data"):
                reg.plan(args={"output": self.output})
        self.assertFalse(self.output.exists())
        self.assertEqual(CALLS, [])

    def test_empty_named_selection_replays_without_evaluating_selector(self):
        reg = eval_live.Registry()
        reg.benchmark("read", collect, version="1", repository=self.repo, error_rows=error_rows)
        reg.table("Empty", empty_named_table, requires={"empty": lambda ts: []}, id='empty')
        result = self.run_eval(reg, render=True)
        self.assertEqual(result.collected, 0)
        self.repo.rename(self.root / "moved")

        def unavailable(treatments):
            raise AssertionError("replay must not evaluate selectors")

        replay = eval_live.Registry()
        replay.table("Empty", empty_named_table, requires={"empty": unavailable}, id='empty')
        self.run_eval(replay, render=True, render_only=True)
        self.assertEqual(self.stored()["eval_runs"], [])
        self.assertEqual(len(self.stored()["eval_requirements"]), 2)

    def test_explicit_sample_treatments_and_shared_requirements(self):
        request = self.request(samples=2)
        reg = eval_live.Registry()
        reg.table("first", table, requires=request, id='first')
        more = self.request(samples=3)
        reg.table("second", table, requires=lambda ts: [*request(ts), *more(ts)], id='second')
        result = self.run_eval(self.evaluation(registry=reg))
        self.assertEqual(result.collected, 3)
        selected = self.stored()["eval_selections"]
        self.assertEqual(sum(row["artifact_id"] == "first" for row in selected), 2)
        self.assertEqual(sum(row["artifact_id"] == "second" for row in selected), 3)
        result = self.run_eval(self.evaluation(self.request(samples=5)))
        self.assertEqual((result.collected, result.reused), (2, 3))

    def test_selection_before_collection_and_invalid_subsets(self):
        reg = eval_live.Registry()
        reg.table("first", table, requires=self.request(factor=1), id='first')
        reg.table("second", table, requires=self.request(factor=2), id='second')
        self.run_eval(self.evaluation(registry=reg), only=["second"])
        self.assertEqual([call[1] for call in CALLS], [{"factor": 2}])
        with self.assertRaisesRegex(ValueError, "subset excludes"):
            self.run_eval(benchmarks=[])
        with self.assertRaisesRegex(ValueError, "unknown artifacts"):
            self.run_eval(only=["missing"])
        self.assertEqual(len(CALLS), 1)

    def test_configuration_inputs_and_unknown_arguments_invalidate(self):
        self.run_eval()
        self.run_eval(self.evaluation(self.request(factor=2)))
        for argument in ("temperature", "baseline"):
            self.run_eval(**{argument: 3})
        self.assertEqual(len(CALLS), 4)
        external = self.root / "input.txt"
        external.write_text("first")
        benchmark = eval_live.Benchmark("read", collect, "1", inputs=[external], error_rows=error_rows)
        self.run_eval(self.evaluation(benchmark=benchmark))
        external.write_text("second")
        self.run_eval(self.evaluation(benchmark=benchmark))
        self.assertEqual(len(CALLS), 6)
        result = self.run_eval(self.evaluation(benchmark=benchmark), only=["values"])
        self.assertEqual(result.collected, 0)

    def test_plot_changes_and_output_path_do_not_invalidate(self):
        self.run_eval()
        reg = eval_live.Registry()
        reg.table("New label", table, requires=self.request(), id="renamed")
        with patch("eval_live.planning.render_artifacts", return_value=[]):
            result = self.evaluation(registry=reg).run(args={"output": self.root / "elsewhere", "data": self.data}, argv=[])
        self.assertEqual(result.collected, 0)

    def test_commit_comparison_isolated_from_dirty_checkout(self):
        (self.repo / "value.txt").write_text("999")
        reg = eval_live.Registry()
        reg.table("comparison", comparison, requires={"baseline": self.request(commit=self.old),
                                                       "candidate": self.request(commit=self.head)}, id='comparison')
        reg.table("reverse", comparison, requires={"baseline": self.request(commit=self.head),
                                                    "candidate": self.request(commit=self.old)}, id='reverse')
        before = self.git("worktree", "list", "--porcelain")
        self.run_eval(self.evaluation(registry=reg), render=True)
        self.assertIn("10 & 20", (self.output / "comparison.tex").read_text())
        self.assertIn("20 & 10", (self.output / "reverse.tex").read_text())
        self.assertEqual([row["value"] for row in self.stored()["measurements"]], [10, 20])
        self.assertEqual((self.repo / "value.txt").read_text(), "999")
        self.assertEqual(before, self.git("worktree", "list", "--porcelain"))

    def test_dirty_worktree_requires_opt_in_and_never_reuses(self):
        (self.repo / "value.txt").write_text("30")
        evaluation = self.evaluation(self.request(commit="WORKTREE"))
        with self.assertRaisesRegex(ValueError, "dirty"):
            self.run_eval(evaluation)
        self.run_eval(evaluation, allow_dirty=True)
        self.run_eval(evaluation, allow_dirty=True)
        self.assertEqual(len(CALLS), 2)
        self.assertTrue(all(not row["cacheable"] for row in self.stored()["eval_runs"]))

    def test_dry_run_never_creates_output_or_runs_benchmark(self):
        result = self.run_eval(dry_run=True)
        self.assertEqual(result.plan.missing, 1)
        self.assertFalse(self.output.exists())
        self.assertEqual(CALLS, [])

    def test_failures_checkpoint_and_independent_requests_continue(self):
        reg = eval_live.Registry()
        reg.table("broken", table, requires=self.request(fail=True, samples=3), id='broken')
        reg.table("working", table, requires=self.request(), id='working')
        result = self.run_eval(self.evaluation(registry=reg))
        self.assertEqual(result.collected, 4)
        data = self.stored()
        self.assertEqual([row["status"] for row in data["eval_runs"]], ["failure", "failure", "failure", "success"])
        self.assertEqual(data["eval_processes"][0]["returncode"], 7)
        self.assertIn("diagnostic", data["eval_processes"][0]["stdout"])
        self.assertEqual({row["artifact_id"] for row in data["eval_selections"]}, {"broken", "working"})
        self.assertEqual(self.run_eval().reused, 1)

    def test_timeout_and_invalid_rows_are_recorded_as_failures(self):
        benchmark = eval_live.Benchmark("read", slow, "1", timeout=0.02, error_rows=error_rows)
        self.run_eval(self.evaluation(benchmark=benchmark))
        self.assertEqual(self.stored()["eval_runs"][0]["status"], "timed-out")
        self.run_eval(self.evaluation(benchmark=eval_live.Benchmark("read", invalid, "1", error_rows=error_rows)))
        self.assertTrue(all(row["value"] is None for row in self.stored()["measurements"]))

    def test_increasing_timeout_reuses_successes_and_retries_only_timeouts(self):
        benchmark = eval_live.Benchmark("read", timed_collect, "1", error_rows=error_rows)
        reg = eval_live.Registry()
        reg.table("fast", table, requires=self.request(), id='fast')
        reg.table("slow", table, requires=self.request(delayed=True), id='slow')
        evaluation = self.evaluation(registry=reg, benchmark=benchmark)
        self.run_eval(evaluation, timeout=0.01)
        original = self.stored()["eval_runs"]
        self.assertEqual([row["status"] for row in original], ["success", "timed-out"])
        result = self.run_eval(evaluation, timeout=5)
        self.assertEqual((result.reused, result.collected), (1, 1))
        self.assertEqual([config for _, config, _ in CALLS], [{}, {"delayed": True}, {"delayed": True}])
        data = self.stored()
        self.assertEqual(data["eval_runs"][:2], original)
        self.assertEqual([row["timeout"] for row in data["eval_runs"]], [0.01, 0.01, 5])
        self.assertEqual(data["eval_runs"][1]["cache_key"], data["eval_runs"][2]["cache_key"])
        arguments = read_parameters([row for row in data["eval_arguments"] if row["invocation_id"] == result.invocation_id])
        self.assertEqual(arguments["timeout"], 5)
        reg = eval_live.Registry()
        reg.table("fast", table, requires=self.request(), id='fast')
        reg.table("slow", table, requires=self.request(delayed=True), id='slow')
        evaluation = self.evaluation(registry=reg,
                                     benchmark=eval_live.Benchmark("read", timed_collect, "1", timeout=10, error_rows=error_rows))
        result = self.run_eval(evaluation)
        self.assertEqual((result.reused, result.collected), (2, 0))

    def test_cached_timeout_blocks_equal_or_smaller_deadlines_and_force_overrides(self):
        evaluation = self.evaluation(self.request(delayed=True),
                                     benchmark=eval_live.Benchmark("read", timed_collect, "1", timeout=0.01, error_rows=error_rows))
        self.run_eval(evaluation)
        for deadline in (0.01, 0.005):
            self.run_eval(evaluation, timeout=deadline)
        self.assertEqual(len(CALLS), 1)
        plan = self.run_eval(evaluation, timeout=0.01, dry_run=True).plan
        self.assertEqual(plan.missing, 0)
        self.assertEqual(plan.reused, 1)
        self.run_eval(evaluation, timeout=0.01, force=True)
        self.assertEqual(len(CALLS), 2)

    def test_timeout_retry_collects_only_failed_treatments(self):
        evaluation = self.evaluation(self.request(after_first=True, samples=3),
                                     benchmark=eval_live.Benchmark("read", timed_collect, "1", error_rows=error_rows))
        self.run_eval(evaluation, timeout=0.01)
        result = self.run_eval(evaluation, timeout=5)
        self.assertEqual((result.reused, result.collected), (1, 2))
        self.assertEqual([sample for _, _, sample in CALLS], [0, 1, 2, 1, 2])
        self.assertEqual(len(self.stored()["eval_selections"]), 6)

    def test_raising_timeout_can_reuse_older_successes_without_retrying(self):
        evaluation = self.evaluation(self.request(delayed=True, samples=2),
                                     benchmark=eval_live.Benchmark("read", timed_collect, "1", error_rows=error_rows))
        original = self.run_eval(evaluation, timeout=5)
        self.run_eval(evaluation, timeout=0.01, force=True)
        result = self.run_eval(evaluation, timeout=5)
        self.assertEqual((result.reused, result.collected), (2, 0))
        self.assertEqual(len(CALLS), 4)
        data = self.stored()
        def selected(invocation):
            return [row["run_id"] for row in data["eval_selections"] if row["invocation_id"] == invocation]

        self.assertEqual(selected(original.invocation_id), selected(result.invocation_id))

    def test_increased_timeout_does_not_retry_ordinary_failures(self):
        evaluation = self.evaluation(self.request(fail=True))
        self.run_eval(evaluation)
        self.run_eval(evaluation, timeout=600)
        self.assertEqual(len(CALLS), 1)
        self.run_eval(evaluation, timeout=600, force=True)
        self.assertEqual(len(CALLS), 2)

    def test_legacy_timeout_keys_are_reused_without_rewriting_observations(self):
        self.run_eval()
        data = self.stored()
        row = data["eval_runs"][0]
        data.pop("eval_requirements")
        row.pop("data_version")
        row["sample"] = 0  # Earlier writers recorded their internal attempt index.
        row["cache_key"] = digest({
            "repository": row["repository"], "commit": row["commit"], "dirty": row["dirty"],
            "benchmark": row["benchmark"], "runner": row["runner_id"], "config": row["config_id"],
            "inputs": [{"path": item["path"], "sha256": item["sha256"]} for item in data["eval_inputs"]],
            "environment": row["environment_id"], "timeout": row["timeout"],
        })
        self.data.write_text(json.dumps(data))
        result = self.run_eval(timeout=600)
        self.assertEqual((result.reused, result.collected), (1, 0))
        self.assertEqual(self.stored()["eval_runs"][0], row)
        result = self.run_eval(self.evaluation(self.request(samples=2)), timeout=600)
        self.assertEqual((result.reused, result.collected), (1, 1))
        self.assertEqual([row["sample"] for row in self.stored()["measurements"]], [0, 1])

    def test_timeout_cli_and_programmatic_validation(self):
        parser = eval_live.add_arguments(argparse.ArgumentParser())
        self.assertIsNone(parser.parse_args([]).timeout)
        self.assertEqual(parser.parse_args(["--timeout", "0.5"]).timeout, 0.5)
        for token in ("0", "-1", "inf", "nan", "abc"):
            with patch("sys.stderr"), self.assertRaises(SystemExit):
                parser.parse_args(["--timeout", token])
        for deadline in (0, -1, float("inf"), float("nan"), True):
            with self.assertRaises(ValueError):
                self.run_eval(timeout=deadline)
        self.assertFalse(self.output.exists())

    def test_committed_directories_ignore_generated_files_and_share_hashes(self):
        from eval_live.targets import Target
        (self.repo / "src").mkdir()
        (self.repo / "src/worker.py").write_text("VALUE = 20")
        self.git("add", "src")
        self.commit_value(20)
        for path in (".", "src"):
            with self.subTest(path=path):
                benchmark = eval_live.Benchmark("read", collect_directory, "1", inputs=[path], error_rows=error_rows)
                reg = self.evaluation(self.request(samples=3), benchmark=benchmark)
                reg.macros("Count", macros)
                result = self.run_eval(reg)
                self.assertEqual(result.collected, 3)
                self.assertTrue(all(run["status"] == "success" for run in self.stored()["eval_runs"]))
                hashes, identity = Target.input_hashes, eval_live.Benchmark.identity
                with patch.object(Target, "input_hashes", autospec=True, side_effect=hashes) as hashed, \
                        patch.object(eval_live.Benchmark, "identity", autospec=True, side_effect=identity) as identified:
                    self.assertEqual(reg.plan(args={"output": self.output}).reused, 3)
                self.assertEqual(hashed.call_count, 1)
                self.assertEqual(identified.call_count, 1)

    def test_committed_directory_checks_still_reject_tracked_mutations(self):
        from eval_live.targets import Target
        target = Target.resolve(self.repo, "HEAD")
        expected = target.input_hashes(["."])
        with target.checkout() as directory:
            self.assertTrue(target.inputs_match(["."], expected, directory))
            (directory / "generated").write_text("scratch")
            self.assertTrue(target.inputs_match(["."], expected, directory))
            (directory / "value.txt").write_text("changed")
            self.assertFalse(target.inputs_match(["."], expected, directory))
            self.git("-C", str(directory), "add", "value.txt")
            self.assertFalse(target.inputs_match(["."], expected, directory))
            (directory / "value.txt").unlink()
            self.assertFalse(target.inputs_match(["."], expected, directory))

    def test_browser_callback_preflight_checks_only_selected_outputs(self):
        reg = self.evaluation()
        reg.table("Invalid", lambda data: [], id="invalid")
        self.assertEqual(reg.plan(args={"output": self.output}).missing, 1)
        with self.assertRaisesRegex(ValueError, "named top-level"):
            self.run_eval(reg)
        self.assertFalse(self.output.exists())
        self.assertEqual(CALLS, [])
        self.run_eval(reg, render=True, only=["values"])
        before = self.data.read_bytes()
        with self.assertRaisesRegex(ValueError, "named top-level"):
            self.run_eval(reg, render_only=True)
        self.assertEqual(self.data.read_bytes(), before)
        self.assertTrue((self.output / "index.html").exists())

    def test_browser_callback_preflight_checks_filters_and_source_files(self):
        reg = self.evaluation()
        reg.table("Filtered", table, interactive_filter=lambda rows, data: data, id="filtered")
        with self.assertRaisesRegex(ValueError, "named top-level"):
            self.run_eval(reg)
        from eval_live.latex import escape
        reg = self.evaluation()
        reg.table("Helper", escape, id="helper")
        with self.assertRaisesRegex(ValueError, "one source file"):
            self.run_eval(reg)
        self.assertEqual(CALLS, [])
        self.assertFalse(self.output.exists())

    def test_render_only_interrupt_records_interrupted_status(self):
        from dataclasses import replace
        reg = self.evaluation()
        self.run_eval(reg, render=True)
        reg._outputs[0] = replace(reg._outputs[0], render=interrupted_figure)
        with self.assertRaises(KeyboardInterrupt):
            self.run_eval(reg, render=True, render_only=True)
        self.assertEqual(self.stored()["eval_invocations"][-1]["status"], "interrupted")
        self.assertTrue(self.stored()["eval_invocations"][-1]["collection_complete"])
        self.assertFalse((self.output / "index.html").exists())
        self.assertEqual(len(CALLS), 1)

    def test_html_contains_union_of_referenced_runs_and_reachable_provenance(self):
        benchmark = eval_live.Benchmark("read", logged_collect, "1", inputs=["value.txt"], error_rows=error_rows)

        def evaluation(request=None, registry=None):
            return self.evaluation(request, registry, benchmark=benchmark)

        # Populate older attempts and another configuration in the same database.
        original = self.run_eval(evaluation(self.request(samples=3)), render=True)
        self.run_eval(evaluation(self.request(samples=3)), force=True)
        self.run_eval(evaluation(self.request(factor=9)))
        reg = eval_live.Registry()
        reg.table("Comparison", comparison, requires={
            "baseline": self.request(samples=1, commit=self.old),
            "candidate": self.request(samples=1)}, id="comparison")
        reg.table("Values", table, requires=self.request(samples=2), id="values")
        reg.table("Empty", empty_named_table, requires={"empty": lambda ts: []}, id="empty")
        reg = evaluation(registry=reg)
        current = self.run_eval(reg, render=True)

        def check_report(result, expected_count):
            page = (self.output / "index.html").read_text()
            embedded, _ = json.JSONDecoder().raw_decode(page.split('<script>initEvalLive("report", ', 1)[1])
            saved = self.stored()
            expected = {row["run_id"] for row in saved["eval_selections"]
                        if row["invocation_id"] == result.invocation_id}
            self.assertEqual(len(expected), expected_count)
            self.assertEqual({row["run_id"] for row in embedded["eval_runs"]}, expected)
            self.assertEqual({row["run_id"] for row in embedded["measurements"]}, expected)
            self.assertEqual({row["invocation_id"] for row in embedded["eval_selections"]}, {result.invocation_id})
            self.assertEqual(len(embedded["eval_requirements"]), len([row for row in saved["eval_requirements"]
                             if row["invocation_id"] == result.invocation_id]))
            # The projection must still be a complete, valid provenance database.
            report_path = self.root / "report-data.json"
            report_path.write_text(json.dumps(embedded))
            eval_live.Store(report_path)
            self.assertGreater(len(saved["eval_runs"]), len(embedded["eval_runs"]))
            self.assertEqual(len(embedded["eval_processes"]), expected_count)
            for name in ("eval_inputs", "eval_processes", "eval_commands"):
                self.assertTrue(embedded[name])
                self.assertTrue(all(row["run_id"] in expected for row in embedded[name]))
            return embedded

        page = check_report(current, 3)
        self.assertEqual({row["commit"] for row in page["eval_runs"]}, {self.head, self.old})
        self.assertGreater(len({row["invocation_id"] for row in page["eval_runs"]}), 1)
        replay = self.run_eval(reg, render=True, render_only=True, invocation=current.invocation_id, only=["comparison"])
        check_report(replay, 2)
        replay = self.run_eval(reg, render=True, render_only=True, invocation=replay.invocation_id, only=["comparison"])
        check_report(replay, 2)
        # An explicit older invocation retains its original attempts, even after --force.
        replay = self.run_eval(evaluation(self.request(samples=3)), render=True, render_only=True,
                               invocation=original.invocation_id)
        page = check_report(replay, 3)
        self.assertEqual({row["invocation_id"] for row in page["eval_runs"]}, {original.invocation_id})

    def test_mutating_materialized_inputs_cannot_produce_a_cache_hit(self):
        benchmark = eval_live.Benchmark("read", mutate_input, "1", inputs=["value.txt"], error_rows=error_rows)
        self.run_eval(self.evaluation(benchmark=benchmark))
        self.assertTrue(all(row["value"] is None for row in self.stored()["measurements"]))
        self.assertEqual(self.stored()["eval_runs"][0]["status"], "failure")

    def test_build_shared_across_configs_and_skipped_for_cache_hits(self):
        benchmark = eval_live.Benchmark("read", use_binary, "1", build=build, inputs=["value.txt"], error_rows=error_rows)
        requests = [self.request(value=1, samples=2), self.request(value=2)]
        reg = eval_live.Registry()
        reg.table("values", table, requires=lambda ts: [t for select in requests for t in select(ts)], id='values')
        evaluation = self.evaluation(registry=reg, benchmark=benchmark)
        result = self.run_eval(evaluation)
        self.assertEqual(result.collected, 3)
        self.assertEqual(len(BUILDS), 1)
        self.assertTrue(all(row["binary_sha256"] for row in self.stored()["eval_runs"]))
        self.assertEqual(self.run_eval(evaluation).collected, 0)
        self.assertEqual(len(BUILDS), 1)

    def test_force_preserves_history_and_render_only_uses_saved_selection_without_git(self):
        original = self.run_eval()
        old_ids = {row["run_id"] for row in self.stored()["eval_runs"]}
        self.run_eval(force=True)
        self.assertEqual(len(CALLS), 2)
        self.repo.rename(self.root / "moved")
        with patch("eval_live.targets.Target.resolve", side_effect=AssertionError("must not use Git")):
            result = self.run_eval(render_only=True, invocation=original.invocation_id)
        ids = {row["run_id"] for row in self.stored()["eval_selections"] if row["invocation_id"] == result.invocation_id}
        self.assertEqual(ids, old_ids)
        self.assertEqual(result.collected, 0)

    def test_all_arguments_and_scalar_types_roundtrip(self):
        self.run_eval(empty=[], mixed=[None, True, 1, 1.0, "1"])
        args = read_parameters(self.stored()["eval_arguments"])
        self.assertEqual(args["empty"], [])
        self.assertEqual([type(v) for v in args["mixed"]], [type(None), bool, int, float, str])
        self.assertFalse(args["force"])
        self.assertEqual(args["output"], str(self.output))

    def test_corrupt_provenance_is_rejected_before_execution(self):
        self.run_eval()
        original = self.data.read_text()
        for table_name, field, value in (("eval_runs", "cache_key", "incorrect"),
                                          ("measurements", "value", [1, 2]),
                                          ("eval_selections", "run_id", "missing")):
            data = json.loads(original)
            data[table_name][0][field] = value
            self.data.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "invalid or incompatible"):
                self.run_eval()
            self.assertEqual(len(CALLS), 1)
        self.data.write_text(original)

    def test_interrupt_records_process_and_attempt(self):
        before = self.git("worktree", "list", "--porcelain")
        outcome = ProcessResult(("worker",), str(self.repo), 0.1, -9, "partial stdout", "", "interrupted")
        benchmark = eval_live.Benchmark("read", slow, "1", error_rows=error_rows)
        with patch("eval_live.benchmarks.run_command", side_effect=ProcessInterrupted(outcome)):
            with self.assertRaises(KeyboardInterrupt):
                self.run_eval(self.evaluation(benchmark=benchmark))
        data = self.stored()
        self.assertEqual(data["eval_invocations"][0]["status"], "interrupted")
        self.assertEqual(data["eval_runs"][0]["status"], "interrupted")
        self.assertEqual(data["eval_processes"][0]["stdout"], "partial stdout")
        self.assertEqual(self.git("worktree", "list", "--porcelain"), before)

    def test_interrupt_while_preparing_checkout_removes_worktree(self):
        from eval_live.targets import git

        before = self.git("worktree", "list", "--porcelain")
        directories = []

        def interrupt_after_add(repository, *arguments):
            result = git(repository, *arguments)
            if arguments[:2] == ("worktree", "add"):
                directories.append(Path(arguments[-2]))
                raise KeyboardInterrupt
            return result

        with patch("eval_live.targets.git", side_effect=interrupt_after_add):
            with self.assertRaises(KeyboardInterrupt):
                self.run_eval()
        self.assertEqual(len(directories), 1)
        self.assertFalse(directories[0].parent.exists())
        self.assertEqual(self.git("worktree", "list", "--porcelain"), before)
        self.assertEqual(self.stored()["eval_runs"][0]["status"], "interrupted")
        self.assertEqual(CALLS, [])

    def test_protocol_version_and_helper_code_invalidate_cache(self):
        self.run_eval()
        result = self.run_eval(self.evaluation(benchmark=eval_live.Benchmark("read", collect, "2", inputs=["value.txt"], error_rows=error_rows)))
        self.assertEqual(result.collected, 1)
        self.assertEqual([row["data_version"] for row in self.stored()["eval_runs"]], ["1", "2"])
        result = self.run_eval(self.evaluation(benchmark=eval_live.Benchmark("read", collect, "2", inputs=["value.txt"], dependencies=[table], error_rows=error_rows)))
        self.assertEqual(result.collected, 1)

    def test_exports_share_samples_and_write_only_one_json_data_file(self):
        self.run_eval(self.evaluation(self.request(samples=3)))
        request = self.request(samples=2)
        reg = eval_live.Registry()
        reg.table("values", table, requires=request, id='values')
        reg.graph("figure", figure, requires=request)
        reg.macros("macros", macros, requires=request)
        result = self.run_eval(self.evaluation(registry=reg), render=True)
        self.assertEqual((result.collected, result.reused), (0, 2))
        self.assertEqual(len(reg.run_tables(self.stored())[0]["rows"]), 3)
        self.assertEqual({p.name for p in self.output.glob("*.json")}, {"results.json"})
        self.assertIn(r"\newcommand{\PaperCount}{2}", (self.output / "macros.tex").read_text())
        self.assertIn(r"x\_y \& z", (self.output / "macros.tex").read_text())
        self.assertTrue((self.output / "figure.pdf").read_bytes().startswith(b"%PDF"))
        page = (self.output / "index.html").read_text()
        self.assertIn("_eval_live_report.py", page)
        self.assertIn("initEvalLive", page)

    def test_registry_plan_and_invalid_registration_fail_before_collection(self):
        reg = self.evaluation()
        plan = reg.plan(args={"output": self.output})
        self.assertEqual(plan.missing, 1)
        self.assertFalse(self.output.exists())
        with self.assertRaisesRegex(ValueError, "duplicate benchmark"):
            reg.benchmark("read", collect, version="1", error_rows=error_rows)
        with self.assertRaisesRegex(ValueError, "filename-safe"):
            reg.table("invalid", table, id="../escape")
        with self.assertRaisesRegex(ValueError, "selector"):
            reg.table("invalid", table, requires={"empty": []}, id='invalid')
        reg.table("Values!", table, requires=self.request(), id='values')
        with self.assertRaisesRegex(ValueError, "IDs.*unique"):
            self.run_eval(reg)
        self.assertEqual(CALLS, [])

    def test_table_function_name_controls_export_and_selection_across_title_changes(self):
        for title in ("Static text", "A renamed display title"):
            reg = eval_live.Registry()
            self.assertIs(reg.table(title)(constant_table), constant_table)
            result = self.run_eval(reg, render=True, only=["constant_table"])
            self.assertEqual(result.collected, 0)
            self.assertIn("No benchmark required", (self.output / "constant_table.tex").read_text())
        self.assertEqual({r["artifact_id"] for r in self.stored()["eval_requirements"]}, {"constant_table"})

    def test_registry_can_render_static_outputs_without_benchmarks(self):
        reg = eval_live.Registry()
        reg.table("Static text", constant_table, id='static-text')
        result = self.run_eval(reg, render=True)
        self.assertEqual(result.collected, 0)
        self.assertIn("No benchmark required", (self.output / "static-text.tex").read_text())
        self.assertEqual(self.stored()["eval_runs"], [])
        self.run_eval(reg, render=True, render_only=True)


class RegistryTests(unittest.TestCase):
    def test_interactive_filter_propagates_across_commits_with_separate_requirements(self):
        reg = eval_live.Registry()
        measurements = [{"run_id": f"{revision}-{size}", "size": size, "seconds": seconds}
                        for revision in ("old", "new") for size, seconds in ((10, 1), (20, 4))]
        data = {
            "measurements": measurements,
            "eval_runs": [{"run_id": row["run_id"], "config_id": row["run_id"].split("-")[0]}
                          for row in measurements],
            "eval_configs": [{"config_id": revision} for revision in ("old", "new")],
            "eval_requirements": [{"requirement": "saved"}],
            "eval_selections": [{"requirement": "saved", "run_id": row["run_id"]}
                                for row in measurements],
        }
        snapshot = json.dumps(data, sort_keys=True)

        def narrow(rows, shared):
            sizes = {row["size"] for row in rows}
            return {**shared, "measurements": [row for row in shared["measurements"]
                                               if row["size"] in sizes]}

        @reg.table("Current", requires=lambda ts: ts, interactive_filter=narrow)
        def current(data):
            return data["measurements"]

        @reg.table("Comparison", requires={"baseline": lambda ts: ts, "candidate": lambda ts: ts})
        def comparison(data):
            return [{"revision": revision, "size": row["size"]}
                    for revision in ("baseline", "candidate")
                    for row in eval_live.select(data, revision)["measurements"]]

        reg._selections = {"current": {"data": ["new-10", "new-20"]},
                           "comparison": {"baseline": ["old-10", "old-20"],
                                          "candidate": ["new-10", "new-20"]}}
        current_rows = reg.run_tables(data)[0]["rows"]
        self.assertEqual([row["run_id"] for row in current_rows], ["new-10", "new-20"])
        # A measured value can select sizes, then propagate them across commits.
        for cutoff, sizes in ((2, [10]), (0, [])):
            with self.subTest(cutoff=cutoff):
                filtered = reg.apply_table_filters([
                    {"name": "Current", "filtered_rows": [row for row in current_rows
                                                           if row["seconds"] < cutoff]},
                ], data)
                self.assertEqual([row["run_id"] for row in filtered["measurements"]],
                                 [f"{revision}-{size}" for revision in ("old", "new") for size in sizes])
                rendered = reg.run_tables(filtered)
                self.assertEqual([row["run_id"] for row in rendered[0]["rows"]],
                                 [f"new-{size}" for size in sizes])
                self.assertEqual(rendered[1]["rows"],
                                 [{"revision": revision, "size": size}
                                  for revision in ("baseline", "candidate") for size in sizes])
                for name in data.keys() - {"measurements"}:
                    self.assertEqual(filtered[name], data[name])
        self.assertEqual(json.dumps(data, sort_keys=True), snapshot)

    def test_browser_module_supports_registration_without_collection_imports(self):
        module = ModuleType("standalone_eval_live")
        with patch.dict(sys.modules, {module.__name__: module}):
            exec(eval_live.pyodide_lib(), module.__dict__)
            reg = module.Registry()
            reg.benchmark("worker", collect, version="1", error_rows=error_rows)
            reg.table("Values", table, requires=lambda treatments: treatments, id='values')
            self.assertEqual(reg.run_tables({"measurements": [{"value": 7}]})[0]["rows"],
                             [{"value": 7, "sample": 0}])

    def test_original_callbacks_and_filters_work_with_requirements_registered(self):
        reg = eval_live.Registry()
        def request(treatments):
            return treatments
        data = {"measurements": [{"value": 1}, {"value": 2}, {"value": 3}]}

        def keep(rows, data):
            values = {row["value"] for row in rows}
            return {**data, "measurements": [row for row in data["measurements"] if row["value"] in values]}

        reg.table("First table", table, keep, requires=request, caption="Original signature", id='first-table')
        reg.table("Second table", table, keep, id='second-table')
        reg.macros("Paper numbers", macros)
        reg.graph("First table", figure)  # Existing renderers allow graph/table titles to match.
        filtered = reg.apply_table_filters([
            {"name": "First table", "filtered_rows": [{"value": 1}, {"value": 2}]},
            {"name": "Second table", "filtered_rows": [{"value": 2}, {"value": 3}]},
        ], data)
        self.assertEqual(filtered["measurements"], [{"value": 2}])
        self.assertEqual(len(data["measurements"]), 3)
        rendered = reg.run_tables(filtered)
        self.assertEqual(rendered[0]["rows"], [{"value": 2, "sample": 0}])
        self.assertEqual(rendered[0]["caption"], "Original signature")
        self.assertTrue(rendered[0]["has_interactive_filter"])
        with tempfile.TemporaryDirectory() as temporary:
            paths = reg.render_to_dir(filtered, temporary, fmt="svg", dpi=72)
            self.assertTrue(all(isinstance(path, str) for path in paths))
            self.assertEqual({Path(path).name for path in paths},
                             {"first-table.json", "first-table.tex", "second-table.json",
                              "second-table.tex", "paper-numbers.tex", "first-table.svg"})
            self.assertIn(r"\newcommand{\PaperCount}{1}", Path(temporary, "paper-numbers.tex").read_text())

    def test_select_preserves_snapshot_and_handles_empty_filtered_data(self):
        data = {"measurements": [{"run_id": "a", "value": 1}, {"run_id": "b", "value": 2}],
                "eval_runs": [{"run_id": "a", "config_id": "x"}, {"run_id": "b", "config_id": "y"}],
                "eval_configs": [{"config_id": "x", "value": 1}, {"config_id": "y", "value": 2}],
                "eval_selections": [{"requirement": "baseline", "run_id": "a"},
                                    {"requirement": "candidate", "run_id": "b"}]}
        selected = eval_live.select(data, "baseline")
        self.assertEqual(selected["measurements"], [{"run_id": "a", "value": 1}])
        self.assertEqual(selected["eval_configs"], [{"config_id": "x", "value": 1}])
        selected["measurements"][0]["value"] = 99
        self.assertEqual(data["measurements"][0]["value"], 1)
        self.assertEqual(eval_live.select({**data, "measurements": []}, "baseline")["measurements"], [])
        with self.assertRaisesRegex(ValueError, "unknown requirement"):
            eval_live.select(data, "missing")


class StoreTests(unittest.TestCase):
    def test_cached_deadline_eligibility(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = eval_live.Store(Path(temporary) / "results.json")
            store.data["eval_runs"] = [
                dict(run_id="fast", cache_key="key", cacheable=True, status="success", timeout=10, seconds=2),
                dict(run_id="overhead", cache_key="key", cacheable=True, status="success", timeout=10, seconds=12),
                dict(run_id="timeout", cache_key="key", cacheable=True, status="timed-out", timeout=10, seconds=10),
                dict(run_id="error", cache_key="key", cacheable=True, status="failure", timeout=10, seconds=1),
                dict(run_id="interrupted", cache_key="key", cacheable=True, status="interrupted", timeout=10, seconds=1),
            ]
            def select(deadline):
                return [row["run_id"] for row in store.cached("key", timeout=deadline)]

            self.assertEqual(select(10), ["fast", "overhead", "timeout", "error"])
            self.assertEqual(select(11), ["fast", "overhead", "error"])
            self.assertEqual(select(2), ["fast", "timeout", "error"])
            self.assertEqual(select(1), ["timeout", "error"])

    def test_parameters_roundtrip_and_invalid_values(self):
        for value in ({}, {"a": []}, {"a": None}, {"a": [1, "x", False, None, 1.0]}):
            self.assertEqual(read_parameters(parameter_rows(value)), value)
        for value in ({"a": {"b": 1}}, {"a": float("nan")}, {"a": [[1]]}):
            with self.assertRaises(ValueError):
                parameter_rows(value)

    def test_atomic_write_failure_preserves_old_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "data.json"
            path.write_text("original")
            with patch("eval_live.store.os.replace", side_effect=OSError("disk problem")):
                with self.assertRaises(OSError):
                    atomic_write(path, "replacement")
            self.assertEqual(path.read_text(), "original")
            self.assertEqual(list(path.parent.iterdir()), [path])

    def test_lock_schema_and_save_guard(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "results.json"
            store = eval_live.Store(path)
            with self.assertRaises(RuntimeError):
                store.save()
            with store.writer():
                store.save()
                with self.assertRaisesRegex(RuntimeError, "another writer"):
                    with eval_live.Store(path).writer():
                        self.fail("second writer entered")
            data = json.loads(path.read_text())
            data["eval_metadata"][0]["schema_version"] = 99
            path.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "incompatible"):
                eval_live.Store(path)


if __name__ == "__main__":
    unittest.main()
