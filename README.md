# eval-live

eval-live is an opinionated way to run paper evaluations: one Python script
generates all the figures, tables, LaTeX macros, and an interactive report.
With no arguments, it runs the entire evaluation and opens the report in your
browser. CLI arguments change parameters or select subsets.

Declare the treatments you can run and the data each figure needs. eval-live
combines those requests, reuses cached measurements by commit and configuration,
and collects missing data. Results and all CLI arguments, including defaults,
are saved as flat tables in one JSON file. Figures are always recomputed.

## Try the demo

From a checkout of this repository:

```bash
pip install -e '.[render]'
python demo/eval.py
```

The [demo](demo/README.md) compares two local Git commits without a compiler or
external workload. It saves measurements in `demo/out/cache.json` and outputs
in `demo/out/paper/`. Run it again to reuse measurements; use `--no-browser`
for automated runs or `--dry-run` to inspect the work.

**The output directory is disposable:** each run clears all its files. A
subdirectory or symlink stops the run before deletion. Keep sources, caches,
and anything you want to retain outside it.

Export one figure with its data, then replay it using the current script:

```bash
python demo/eval.py --only runtime --output figures/runtime
python demo/eval.py --replay figures/runtime --output figures/replayed-runtime
```

Keep `results.json` and `reproduce.json` alongside the figures. Replay uses only
that bundle's data and recorded selections, without collecting or consulting
the normal cache. See the [CLI reference](docs/cli.rst) for all options.

To install in another project:

```bash
pip install 'eval-live[render] @ git+https://github.com/oflatt/eval-live.git'
```

## Write an evaluation

Use one `Registry` to declare treatments (ordinary configuration dictionaries),
a collection callback, and outputs registered with `@reg.graph`, `@reg.table`,
or `@reg.macros`. An output's `requires` function selects its treatments;
omitting it requests everything. Call `reg.run()` to collect and render.
The [Python guide](docs/python-guide.rst) walks through the API and interactive
filters; [demo/eval.py](demo/eval.py) is a complete example.

Commit workload sources and data, pin dependencies, and read from the selected
worktree. Bump the benchmark's `version` when collection or build code changes:
eval-live relies on Git commits and explicit versions, not source hashing.
Commit the evaluation script before generating final paper outputs.

Every requested treatment has rows before collection starts. Your `error_rows`
callback supplies placeholders for unfinished work and distinct timeout/error
results. Figures decide how to report them; see the guide's
[error handling](docs/python-guide.rst#complete-rows-timeouts-and-errors) and
[advice on misleading results](docs/python-guide.rst#avoid-misleading-results).

## Documentation

- [Python API](docs/api.rst) — callback contracts, rendering, and table styling.
- [Data format](docs/data-format.rst) — cache tables and reproduction records.
- [Browser embedding](docs/browser.rst) — use the viewer in another webpage.
- [Development](docs/development.rst) — tests, randomized stress runs, docs builds,
  and viewer architecture.
