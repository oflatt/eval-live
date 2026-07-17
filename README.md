# eval-live

Interactive HTML tables and Pyodide-powered graphs for evaluation results.
Renders JSON data as filterable, collapsible tables with optional in-browser
Python graphs and computed summary tables. The same table and graph definitions
also render to the terminal and to files (PDF / JSON / LaTeX), so results look
consistent across the web, the CLI, and dumps.

## Install

```bash
pip install git+https://github.com/oflatt/eval-live.git
```

Or for local development:

```bash
pip install -e /path/to/eval-live
```

## Python API

The package bundles JS, CSS, and a Pyodide helper library. Access them as strings
for embedding into a self-contained HTML page:

```python
import eval_live

eval_live.css()          # CSS stylesheet
eval_live.js()           # JavaScript library (defines the entry points below)
eval_live.pyodide_lib()  # eval_live.py source for Pyodide runtime
```

## JavaScript API

The JS library exposes the existing raw/computed-data entry point:

```js
initEvalLive(container, data, name, graphScript, evalLivePy)
```

- **container**: DOM element or element ID
- **data**: `{ tableName: [rowObjects] }` dict
- **name**: project name shown in the heading
- **graphScript** (optional): Python script that builds an `eval_live.Registry`
- **evalLivePy** (optional): source of the `eval_live.py` library (from `eval_live.pyodide_lib()`)

### Precomputed table catalogs

Use `initEvalLiveTables` when another system has already computed the report
tables. It renders the supplied descriptors directly and never starts the graph
engine or loads Pyodide:

```js
initEvalLiveTables("eval-live-root", [
  {
    id: "wall-time-summary",
    name: "Wall time",
    section: "Benchmark Summary",
    caption: "Lower is better.",
    columns: [
      {id: "target", name: "Target", alignment: "left"},
      {id: "duration", name: "Wall time", alignment: "right"},
    ],
    rows: [
      {
        target: "candidate",
        duration: {
          value: 0.118,
          text: "118 ms",
          style: {color: "green"},
        },
      },
    ],
  },
], "Benchmark Report");
```

Descriptors and their `rows` retain their input order. Every descriptor needs a
unique, stable `id`; `name` is display-only, so multiple tables may have the
same name without sharing filter or collapse state. `section` and `caption` are
optional.

The optional `columns` array fixes the displayed columns and their order, even
when `rows` is empty. Each column has a unique stable `id`, a display-only
`name`, and an optional `alignment` of `left`, `center`, or `right`. Row objects
and SQL filters use column ids; headings use names, which may be duplicated.
Extra row properties are not displayed or available to that table's SQL filter.
When `columns` is omitted, ids and names are inferred from the first appearance
of each row key, preserving the original API's behavior. AlaSQL accepts ordinary
ids directly; JavaScript prototype names can be qualified with the built-in
`source` alias, for example `source.constructor < 10`.

Choose explicit column ids as ASCII SQL identifiers (`[A-Za-z_][A-Za-z0-9_]*`)
that are not SQL keywords; put unrestricted human text in `name`. This keeps
typed SQL and checkbox-generated clauses unambiguous. JavaScript prototype
names such as `constructor` are supported through the `source` qualification
shown above.

A cell may be a primitive, the existing `{text, style}` styled-cell shape, or
`{value, text, style}`. The latter shape is recognized only when both `value`
and `text` are own properties, so ordinary objects that happen to contain a
`value` field retain their old behavior. Display and substring filters use
`text`; SQL comparisons and numeric highlighting use `value`. `style` remains
optional and visual-only. The table filters only change the browser display:
this API does not recompute the supplied catalog.

Precomputed tables start with numeric highlighting set to `none`, because a
single report row often mixes unlike units. Viewers can still choose `lowest`
or `highest` from an individual table's highlight control when that comparison
is meaningful.

When tables and explanatory messages must retain one exact document order, use
`initEvalLiveCatalog` with the report's section hierarchy. Table blocks use the
same descriptor fields as above plus `kind: "table"`; message blocks are inert
text with `kind: "message"`, a stable `id`, `text`, and optional `title`, `tone`,
and `layout`:

```js
initEvalLiveCatalog("eval-live-root", [
  {
    id: "timing",
    title: "Engine Timing",
    blocks: [
      {kind: "table", id: "summary", name: "Summary", rows: results},
      {
        kind: "message",
        id: "timing-note",
        text: "Other is wall time minus recorded phases.",
        tone: "muted",
        layout: "caption",
      },
    ],
  },
], "Benchmark Report");
```

Section and block order are preserved, including sections containing only
messages. Messages are rendered with `textContent`; they do not receive table
filters or enter table UI state. Built-in tones are `default`, `positive`,
`negative`, `warning`, `error`, and `muted`; layouts are `text` and `caption`.

## Graphs and computed tables

Define graphs and tables in a Python script using the `Registry` API:

```python
import eval_live

reg = eval_live.Registry()
reg.graph("My Graph", my_graph_fn)
reg.table("Summary", summary_fn, filter_source=summary_filter_fn)
eval_live.registry = reg
```

See `eval_live/eval_live.py` for full documentation on graphs, tables, and
filter propagation.

## Rendering to the terminal and disk

A `Registry` renders outside the browser too, from the same `data` dict and the
same table definitions, so a table looks consistent everywhere:

```python
reg.render_to_console(data)       # pretty tables in the terminal
reg.render_to_dir(data, "out/")   # graphs -> <slug>.pdf, tables -> <slug>.json + <slug>.tex
```

`render_to_console` uses `rich` (a normal dependency) and accepts an optional
`rich.Console`. `render_to_dir` needs `matplotlib` (`pip install
eval-live[render]`). Graphs are skipped in the terminal (no image).

## Table display: captions and styled cells

Columns and headers are simply the row keys, in first-seen order — so name your
keys the way you want them to appear. The only presentation option is an
optional caption:

```python
reg.table("Timings", timings_fn, caption="Lower is better.")   # caption shown under the table
```

### Styled cells

A cell is normally a scalar. To style it, return a dict instead:

```python
{"text": "1.5x", "style": {"color": "green", "bold": True}}
{"text": "slow", "style": "red"}     # a bare string is shorthand for the color
```

`style` is **purely visual** — eval-live has no notion of "good"/"bad"; what a
style means is up to you. It is a dict with any of:

- `color` — a color (see below)
- `bold` — `true` for bold
- `dim` — `true` for dimmed/muted

or a plain string used as the `color`.

**What colors work:** the color is passed to the terminal renderer (`rich`) and,
in the browser, set as a CSS color, so use a value both understand. The basic
names — `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white` —
and hex such as `#1b6b35` work everywhere. The terminal additionally accepts any
[rich style](https://rich.readthedocs.io/en/stable/style.html); the browser
additionally accepts any CSS color. LaTeX dumps ignore styling and keep the text.

To pass parameters to computed tables/graphs, add an ordinary one-row table to
the data (e.g. `data["params"] = [{"threshold": 0.5}]`) and read it in your
functions. It is shown as a small raw table like any other.

## Standalone page

Open `eval_live/index.html` in a browser to load a JSON file via file picker.

## Architecture

The viewer is a small state-driven app (no framework). There is one `state`
object (`state.js`); events run reducers via `setState`, which re-renders:

```
event -> setState(reducer) -> render(state)  [+ engine.tick(state)]
```

- **state.js** — the single state object plus *pure* derivations (row filtering,
  `rawFilteredData`, clause helpers) and reducers. No DOM, no async; unit-tested
  directly in node.
- **table-view.js** — `buildTableView` builds a table's DOM once, then
  `sync(state)` reconciles it (collapsed class, input values, checkbox state, row
  visibility). It stores no UI state, so collapse/filters survive re-renders.
- **graph-engine.js** — `createEngine`: the expensive Pyodide work as *memoized
  async effects* forming an acyclic DAG, writing results back through `setState`:

  ```
  rawFilteredData ─▶ computedUnfiltered ─▶ narrowing ─▶ effectiveRawData ─▶ { computed tables (displayed), graphs, raw display }
                       (checkbox options +        (acyclic: narrowing's
                        narrowing selection)       inputs never depend on it)
  ```

  A filter on any table — raw or computed — narrows everything: raw rows, graphs,
  and all computed tables. The narrowing *selection* and the checkbox *options*
  are taken from the unfiltered tables (`computedUnfiltered`), so options don't
  vanish as the displayed rows shrink, and there is no recompute cycle.
- **eval-live.js** — `initEvalLive`, `initEvalLiveTables`, and
  `initEvalLiveCatalog`: own the state, wire reducers, and reconcile graph, raw,
  computed, and precomputed report views.

## Tests

Pure-JS unit + DOM-smoke tests, no npm/jsdom (they run the browser modules in a
`node:vm` context with a tiny DOM shim):

```bash
node test/state.test.mjs   # state core: filtering, reducers, SQL-clause helpers
node test/dom.test.mjs      # all public JS APIs: DOM wiring and AlaSQL filtering
```

The Pyodide engine is exercised in the browser, not in these tests.
