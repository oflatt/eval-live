/* Dependency-free unit tests for the eval-live state core (state.js) and the
   SQL and checkbox filtering helpers. No npm, no jsdom: we run the
   two browser modules inside a node:vm context (where their top-level function
   declarations become context globals) and assert against them directly.

   Most cases omit AlaSQL to exercise plain text fallback; SQL-specific cases
   load the bundled engine. Run: `node test/state.test.mjs`. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import assert from "node:assert/strict";

const dir = new URL("../eval_live/", import.meta.url);
const ctx = { console, module: { exports: {} } };
vm.createContext(ctx);
for (const f of ["sql-filter.js", "state.js"]) {
  vm.runInContext(readFileSync(new URL(f, dir), "utf8"), ctx, { filename: f });
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("  ok  " + name);
}
// vm-context arrays/objects come from another realm, so deepStrictEqual rejects
// them on prototype identity. Compare by structure via JSON instead.
function eq(actual, expected, msg) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), msg);
}

const ROWS = [
  { backend: "feldera", mode: "proofs", file: "a.egg" },
  { backend: "feldera", mode: "naive", file: "b.egg" },
  { backend: "flowlog", mode: "proofs", file: "c.egg" },
  { backend: "flowlog", mode: "naive", file: "d.egg" },
];
const COLS = ctx.columnsOf(ROWS);

test("columnsOf collects every key once, in order", () => {
  eq(COLS, ["backend", "mode", "file"]);
});

test("per-column substring filter (ANDed, case-insensitive)", () => {
  const ui = ctx.makeTableUi("raw");
  ui.colFilters = { backend: "FELD", mode: "proof" };
  eq(ctx.visibleRowIndices(ROWS, COLS, ui), [0]);
});

test("empty ui shows all rows", () => {
  eq(ctx.visibleRowIndices(ROWS, COLS, ctx.makeTableUi("raw")), [0, 1, 2, 3]);
});

test("sql box with no AlaSQL falls back to substring across columns", () => {
  const ui = ctx.makeTableUi("raw");
  ui.sql = "flowlog";        // bare word -> substring fallback
  eq(ctx.visibleRowIndices(ROWS, COLS, ui), [2, 3]);
});

test("cellText matches historic rendering (null -> 'null', undefined -> '')", () => {
  assert.equal(ctx.cellText(undefined), "");
  assert.equal(ctx.cellText(null), "null");
  assert.equal(ctx.cellText({ a: 1 }), '{"a":1}');
  assert.equal(ctx.cellText(42), "42");
});

test("rawFilteredData applies raw filters and preserves empty tables", () => {
  const state = ctx.makeState({ runs: ROWS, empty: [] }, "P");
  ctx.setColFilter(state, "runs", "backend", "feldera");
  const fd = ctx.rawFilteredData(state);
  eq(Object.keys(fd), ["runs", "empty"]);
  eq(fd.empty, []);
  assert.equal(fd.runs.length, 2);
});

test("reducers report change and are idempotent", () => {
  const state = ctx.makeState({ runs: ROWS });
  assert.equal(ctx.toggleCollapsed(state, "runs"), true);
  assert.equal(state.ui.tables[ctx.tableKey("runs")].collapsed, true);
  assert.equal(ctx.setSql(state, "runs", "x"), true);
  assert.equal(ctx.setSql(state, "runs", "x"), false);      // no-op -> false
  assert.equal(ctx.setColFilter(state, "runs", "mode", ""), false); // unset stays unset
  assert.equal(ctx.setColFilter(state, "runs", "mode", "p"), true);
});

test("clearAllFilters resets sql + colFilters across all tables", () => {
  const state = ctx.makeState({ runs: ROWS });
  ctx.setSql(state, "runs", "feldera");
  ctx.setColFilter(state, "runs", "mode", "proofs");
  assert.equal(ctx.clearAllFilters(state), true);
  assert.equal(state.ui.tables[ctx.tableKey("runs")].sql, "");
  eq(state.ui.tables[ctx.tableKey("runs")].colFilters, {});
  assert.equal(ctx.clearAllFilters(state), false);          // already clear
});

test("checkboxes combine across columns without changing SQL", () => {
  const state = ctx.makeState({runs: ROWS});
  ctx.setSql(state, "runs", "proofs");
  ctx.toggleCheckbox(state, "runs", "backend", ["flowlog"], ["feldera", "flowlog"]);
  eq(ctx.rawFilteredData(state).runs, [ROWS[2]]);
  ctx.toggleCheckbox(state, "runs", "mode", ["naive"], ["proofs", "naive"]);
  eq(ctx.rawFilteredData(state).runs, []);
  assert.equal(ctx.ensureTableUi(state, "runs").sql, "proofs");
  ctx.setSql(state, "runs", "");
  eq(ctx.rawFilteredData(state).runs, [ROWS[3]]);
  ctx.setColFilter(state, "runs", "file", "c");
  eq(ctx.rawFilteredData(state).runs, []);
});

test("checkboxes never rewrite arbitrary SQL text", () => {
  const state = ctx.makeState({runs: ROWS});
  const sql = "file LIKE '% AND  x%' OR (mode = 'proofs' AND size BETWEEN 1 AND 2)";
  ctx.setSql(state, "runs", sql);
  ctx.toggleCheckbox(state, "runs", "backend", ["feldera"], ["feldera", "flowlog"]);
  assert.equal(ctx.ensureTableUi(state, "runs").sql, sql);
  ctx.clearAllFilters(state);
  assert.equal(ctx.hasFilters(ctx.ensureTableUi(state, "runs")), false);
  eq(ctx.rawFilteredData(state).runs, ROWS);
});

test("effectiveRawData narrows graph data by engine.narrowing", () => {
  const state = ctx.makeState({ runs: ROWS });
  // no narrowing -> identical to rawFilteredData
  eq(ctx.effectiveRawData(state).runs.length, 4);
  // narrowing keeps only the listed rows (matched by JSON identity)
  state.engine.narrowing = { runs: [ROWS[0], ROWS[2]] };
  eq(ctx.effectiveRawData(state).runs, [ROWS[0], ROWS[2]]);
  // a raw filter still applies first, then the narrowing intersects
  ctx.setColFilter(state, "runs", "mode", "proofs"); // rows 0 and 2
  eq(ctx.effectiveRawData(state).runs, [ROWS[0], ROWS[2]]);
});

test("computedFilterInputs: from UNFILTERED tables, only when filter is active", () => {
  const state = ctx.makeState({ runs: ROWS });
  state.engine.computedUnfiltered = [
    { name: "summary", hasInteractiveFilter: true, rows: ROWS },
    { name: "nofs", hasInteractiveFilter: false, rows: ROWS },
  ];
  // no ui / no filter -> nothing to narrow
  eq(ctx.computedFilterInputs(state), []);
  // a filter on the interactive_filter table -> its selected rows are emitted
  ctx.ensureTableUi(state, "summary", "computed");
  ctx.setColFilter(state, "summary", "backend", "feldera", "computed");
  const cf = ctx.computedFilterInputs(state);
  eq(cf.length, 1);
  eq(cf[0].name, "summary");
  eq(cf[0].filtered_rows.length, 2);
  // a filter on a table WITHOUT an interactive_filter is ignored
  ctx.ensureTableUi(state, "nofs", "computed");
  ctx.setColFilter(state, "nofs", "backend", "feldera", "computed");
  eq(ctx.computedFilterInputs(state).length, 1);
});

test("distinctScalarValues: sorted distinct, null for non-scalar columns", () => {
  eq(ctx.distinctScalarValues(ROWS, "backend"), ["feldera", "flowlog"]);
  eq(ctx.distinctScalarValues([{ x: 1 }, { x: undefined }, {}], "x"), [1, null]);
  assert.equal(ctx.distinctScalarValues([{ x: { a: 1 } }], "x"), null);
});

test("isNumericValue accepts numbers and numeric strings only", () => {
  for (const v of [3, 0, -2.5, "4", " 1.0 ", "1e3"]) assert.equal(ctx.isNumericValue(v), true);
  for (const v of ["", "abc", null, undefined, {}, true, NaN, Infinity]) assert.equal(ctx.isNumericValue(v), false);
});

test("bestNumericCols: lowest (default), highest, none, ties, >= 2 numbers", () => {
  eq([...ctx.bestNumericCols({ a: 5, b: 2, c: 9, name: "x" }, ["a", "b", "c", "name"], "lowest")], ["b"]);
  eq([...ctx.bestNumericCols({ a: 5, b: 2, c: 9 }, ["a", "b", "c"], "highest")], ["c"]);
  eq([...ctx.bestNumericCols({ a: 5, b: 2, c: 9 }, ["a", "b", "c"], "none")], []);
  eq([...ctx.bestNumericCols({ a: 2, b: 2, c: 9 }, ["a", "b", "c"], "lowest")], ["a", "b"]); // ties
  eq([...ctx.bestNumericCols({ a: 5, name: "x" }, ["a", "name"], "lowest")], []);            // one number
  eq([...ctx.bestNumericCols({ a: "3", b: "1" }, ["a", "b"], "highest")], ["a"]);            // numeric strings
});

test("setHighlight reducer (default lowest, idempotent)", () => {
  const state = ctx.makeState({ runs: ROWS });
  assert.equal(state.ui.tables[ctx.tableKey("runs")].highlight, "lowest");
  assert.equal(ctx.setHighlight(state, "runs", "highest"), true);
  assert.equal(state.ui.tables[ctx.tableKey("runs")].highlight, "highest");
  assert.equal(ctx.setHighlight(state, "runs", "highest"), false);
});

test("checking all or no values removes only that checkbox constraint", () => {
  const state = ctx.makeState({runs: ROWS});
  const all = ["feldera", "flowlog"];
  for (const reset of [[], all]) {
    ctx.toggleCheckbox(state, "runs", "backend", ["feldera"], all);
    eq(ctx.rawFilteredData(state).runs, ROWS.slice(0, 2));
    ctx.toggleCheckbox(state, "runs", "backend", reset, all);
    eq(ctx.rawFilteredData(state).runs, ROWS);
  }
});

test("resolveActiveGraph: chosen if present, else first, else null", () => {
  const state = ctx.makeState({ runs: ROWS });
  assert.equal(ctx.resolveActiveGraph(state), null);                 // no graphs
  state.engine.graphs = [{ name: "A" }, { name: "B" }];
  assert.equal(ctx.resolveActiveGraph(state), "A");                  // default to first
  ctx.setActiveGraph(state, "B");
  assert.equal(ctx.resolveActiveGraph(state), "B");                  // honor chosen
  state.engine.graphs = [{ name: "A" }];                             // B disappeared
  assert.equal(ctx.resolveActiveGraph(state), "A");                  // fall back to first
});

test("narrowedKeySet / rowKey identify rows by content", () => {
  const set = ctx.narrowedKeySet([ROWS[0], ROWS[2]]);
  assert.equal(set.has(ctx.rowKey(ROWS[0])), true);
  assert.equal(set.has(ctx.rowKey(ROWS[1])), false);
});

test("narrowing ignores dictionary insertion order", () => {
  const state = ctx.makeState({samples: [{id: "a", value: 1}]});
  state.engine.narrowing = {samples: [{value: 1, id: "a"}]};
  eq(ctx.effectiveRawData(state).samples, state.data.samples);
});

test("raw, computed, and diagnostic tables have independent filters", () => {
  const state = ctx.makeState({Summary: [{value: 1}, {value: 2}]});
  ctx.setColFilter(state, "Summary", "value", "1.5", "computed");
  ctx.setColFilter(state, "Summary", "value", "warning", "message");
  eq(ctx.rawFilteredData(state).Summary, state.data.Summary);
  ctx.setColFilter(state, "Summary", "value", "2", "raw");
  eq(ctx.rawFilteredData(state).Summary, [{value: 2}]);
  assert.equal(ctx.ensureTableUi(state, "Summary", "computed").colFilters.value, "1.5");
});

test("checkbox columns accept reserved names, spaces, and punctuation", () => {
  for (const col of ["value", "group", "time (ms)", "a] AND [b", "constructor", "__proto__"]) {
    const rows = [{[col]: "a"}, {[col]: "b"}];
    const state = ctx.makeState({samples: rows});
    ctx.toggleCheckbox(state, "samples", col, ["a"], ["a", "b"]);
    eq(ctx.rawFilteredData(state).samples, [rows[0]]);
  }
});

test("SQL literals retain their types across consecutive queries", () => {
  ctx.alasql = createRequire(import.meta.url)("../eval_live/vendor/alasql.min.js");
  const rows = [{value: true}, {value: "true"}, {value: 1}, {value: "1"}];
  for (const [literal, expected] of [["TRUE", 0], ["'true'", 1], ["1", 2], ["'1'", 3]]) {
    eq([...ctx.sqlMatchSet(`[value] IN (${literal})`, rows)], [expected]);
  }
});

test("checkbox predicates preserve numbers, booleans, strings, null and missing cells", () => {
  const rows = [500, 2000, 9000, true, false, null, undefined, "", "500", "true", "A", "a", "x) AND '  z"]
    .map((value) => ({value}));
  for (const [values, expected] of [
    [[500, 2000], [0, 1]], [[true], [3]], [[false], [4]], [[null], [5, 6]],
    [[""], [7]], [["500"], [8]], [["true"], [9]], [["A"], [10]],
    [[500, null], [0, 5, 6]], [[false, "500", null], [4, 5, 6, 8]],
    [["x) AND '  z", null], [5, 6, 12]],
  ]) {
    const ui = ctx.makeTableUi("raw");
    ui.checkedValues.value = values;
    eq(ctx.visibleRowIndices(rows, ["value"], ui), expected);
  }
  eq(ctx.distinctScalarValues([{v: 1}, {v: "1"}, {v: null}, {}], "v"), [1, "1", null]);
});

test("checkbox-only computed filters propagate to shared inputs", () => {
  const state = ctx.makeState({runs: ROWS});
  state.engine.computedUnfiltered = [{name: "Summary", rows: ROWS, hasInteractiveFilter: true}];
  ctx.toggleCheckbox(state, "Summary", "backend", ["feldera"], ["feldera", "flowlog"], "computed");
  eq(ctx.computedFilterInputs(state), [{name: "Summary", filtered_rows: ROWS.slice(0, 2)}]);
});

test("unsafe browser integers fail rather than round silently", () => {
  assert.throws(() => ctx.makeState({samples: [{value: 2**53}]}), /exact range/);
  assert.equal(ctx.makeState({samples: [{value: "9007199254740993"}]}).data.samples[0].value, "9007199254740993");
});

console.log(`\n${passed} tests passed`);
