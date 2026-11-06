# A complete paper evaluation

From the repository root:

```bash
pip install -e '.[render]'
python demo/eval.py
```

This single script uses one `Registry` for its benchmark, graphs, table, and
macros. It creates a tiny local Git repository with two commits and runs all
four paper outputs. It compares list/set membership across input sizes and
the same set configuration before and after an optimization.
No clone or compiler is needed. The full run requires 27 observations, shared
across the artifact declarations.

| File in `demo/out/paper/` | Contents |
| --- | --- |
| `results.json` | All flat measurement tables, CLI arguments, commit/configuration provenance, process diagnostics, and exact artifact sample selections |
| `runtime.pdf` | Current-commit list and set timings |
| `history.pdf` | The same configuration at two different commits |
| `summary.tex` | Median timings as a LaTeX table |
| `macros.tex` | `\EvalSamples`, `\EvalInputSizes`, and `\EvalBestMedianMs` |
| `index.html` | Interactive raw data, computed outputs, and graphs |

Run it again to reuse all observations. Select outputs or change measurement
parameters with CLI arguments:

```bash
python demo/eval.py
python demo/eval.py --dry-run
python demo/eval.py --samples 5
python demo/eval.py --only summary --sizes 500 2000
python demo/eval.py --seed 42
python demo/eval.py --timeout 60
python demo/eval.py --parallel --jobs 4
python demo/eval.py --force
python demo/eval.py --render-only
python demo/eval.py --help
```

`--render-only` uses the latest completed collection's exact selections. If
that invocation only contained a subset, pass the same `--only` selection or
use `--invocation ID` to choose a complete run. No benchmark repository is
needed for render-only use. Use `--data PATH` to share a cache across artifact
output directories. Every option and its default is recorded, even options
that do not affect measurement identity.

The demo defines `--samples` itself and includes a `sample` index in each
treatment. Both the total CLI count and the individual index affect cache
identity. Changing the count collects fresh results for that configuration;
repeating it reuses them. Median calculation is ordinary Python in the table
callback. `requires` functions select from the declared cross product; they
skip unused baseline/list combinations. An output without a selector would
request the whole catalog.

Timeouts are disabled by default. `--timeout SECONDS` opts into a deadline
for each command. A timed-out or failed treatment still has an explicit row:
`error_rows(treatment, status)` defines its null measurement and status.
Every requested treatment has placeholder rows before execution starts.
Increasing the deadline recollects timeouts and keeps successes; repeating it
reuses timeout rows. `--force` recollects every selected treatment.

The demo's rendering policy warns about timeouts and reports errors for failed
treatments. Medians use completed measurements; the Summary retains requested
and completed counts. Change the calls to `eval_live.warn` and `eval_live.error` in `summary` to
choose a different reporting policy. Messages are deduplicated and computed
fresh on rendering, never saved as measurements. Ctrl+C cancels the evaluation
and its workers, preserves all requested rows, and skips rendering.

Open the HTML directly. Filter Summary by `algorithm = 'set' AND size = 500`
to narrow observations and recompute graphs. Raw tables work without network
access; interactive Python outputs fetch Pyodide and matplotlib from a CDN.
The page does not collect measurements.

Read [eval.py](eval.py) from the top: rendering callbacks registered with
`@reg.table`, `@reg.graph`, and `@reg.macros`, followed by the error-row and
collection functions. `main` declares treatments without commits, registers
the comparison with copies requesting `--baseline`, and runs the evaluation.
Ordinary outputs use `--commit` (HEAD by default). The comparison's legend
uses the saved commit hashes; no display labels enter the treatment configuration.
The workload's source files are in [workload/](workload/); its generated repository
is in `demo/out/repository`. `--commit` and `--baseline` select its revisions.

Collection is sequential by default. `--parallel` adds `parallel=True` to
the treatment dictionaries so they can run in separate processes; `--jobs 4`
limits concurrency to four workers. Unmarked treatments always run alone.
The flag and worker count participate in cache identity. Concurrent timing
measurements share machine resources, so use `--jobs 1` for sequential timings.

Timings are illustrative and vary with machine load. Container construction is
outside the timed region. Each invocation replaces the generated report;
files for unselected outputs are removed. Use separate output directories to
keep several reports. The HTML includes the runs referenced by its outputs;
`results.json` retains the complete history. The sibling `.lock` file is writer
coordination, not stored data.

The [Python guide](../docs/python-guide.rst) covers callback contracts and the
[API reference](../docs/api.rst) is generated from docstrings. A second example,
[egglog_eval.py](egglog_eval.py), adapts a real egglog workload when a compatible
local repository and built binary are available.

In the egglog example, `--binary` selects the executable and `--repository`/
`--commit` select the `.egg` input files. One treatment list combines files,
modes, and sample indices; one `measure` function runs each selected treatment.
`--modes off proof-testing` selects two modes. The binary and input files are
fingerprinted together, so changing either invalidates the cache.
