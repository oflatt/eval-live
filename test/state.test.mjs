/* Dependency-free unit tests for the eval-live state core (state.js) and the
   SQL-clause helpers it shares with sql-filter.js. No npm, no jsdom: we run the
   two browser modules inside a node:vm context (where their top-level function
   declarations become context globals) and assert against them directly.

   The real AlaSQL evaluation path needs a browser-y global and is exercised
   manually; here `alasql` is absent, so sqlMatchSet() returns null and SQL text
   falls back to substring matching -- which is itself a documented behavior we
   assert on. Run: `node test/state.test.mjs`. */
import { readFileSync } from "node:fs";
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

test("rawFilteredData applies each raw table's ui and skips non-raw/empty", () => {
  const state = ctx.makeState({ runs: ROWS, empty: [] }, "P");
  ctx.setColFilter(state, "runs", "backend", "feldera");
  const fd = ctx.rawFilteredData(state);
  eq(Object.keys(fd), ["runs"]);
  assert.equal(fd.runs.length, 2);
});

test("reducers report change and are idempotent", () => {
  const state = ctx.makeState({ runs: ROWS });
  assert.equal(ctx.toggleCollapsed(state, "runs"), true);
  assert.equal(state.ui.tables.runs.collapsed, true);
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
  assert.equal(state.ui.tables.runs.sql, "");
  eq(state.ui.tables.runs.colFilters, {});
  assert.equal(ctx.clearAllFilters(state), false);          // already clear
});

test("columnClauseFor: all checked -> '', subset -> = / IN", () => {
  const all = ["feldera", "flowlog"];
  assert.equal(ctx.columnClauseFor("backend", all, all), "");
  assert.equal(ctx.columnClauseFor("backend", ["feldera"], all), "backend = 'feldera'");
  assert.equal(ctx.columnClauseFor("backend", ["feldera", "flowlog"], ["a", "b", "c"]),
    "backend IN ('feldera', 'flowlog')");
});

test("setColumnClause adds, replaces, and removes a column's clause", () => {
  let sql = "";
  sql = ctx.setColumnClause(sql, "backend", "backend = 'feldera'");
  assert.equal(sql, "backend = 'feldera'");
  sql = ctx.setColumnClause(sql, "mode", "mode = 'proofs'");
  assert.equal(sql, "backend = 'feldera' AND mode = 'proofs'");
  // replace backend's clause without disturbing mode
  sql = ctx.setColumnClause(sql, "backend", "backend IN ('feldera', 'flowlog')");
  assert.equal(sql, "mode = 'proofs' AND backend IN ('feldera', 'flowlog')");
  // remove mode's clause, no dangling AND
  sql = ctx.setColumnClause(sql, "mode", "");
  assert.equal(sql, "backend IN ('feldera', 'flowlog')");
});

test("extractColumnValues recognizes = and IN, returns null otherwise", () => {
  eq(ctx.extractColumnValues("backend = 'feldera'", "backend"), ["feldera"]);
  eq(ctx.extractColumnValues("backend IN ('a', 'b')", "backend"), ["a", "b"]);
  assert.equal(ctx.extractColumnValues("mode = 'proofs'", "backend"), null);
});

test("setColumnClause preadds user-typed clauses survive a removal", () => {
  let sql = "file LIKE '%.egg%' AND backend = 'feldera'";
  sql = ctx.setColumnClause(sql, "backend", "");
  assert.equal(sql, "file LIKE '%.egg%'");
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
    { name: "summary", hasFilterSource: true, rows: ROWS },
    { name: "nofs", hasFilterSource: false, rows: ROWS },
  ];
  // no ui / no filter -> nothing to narrow
  eq(ctx.computedFilterInputs(state), []);
  // a filter on the filter_source table -> its selected rows are emitted
  ctx.ensureTableUi(state, "summary", "computed");
  ctx.setColFilter(state, "summary", "backend", "feldera");
  const cf = ctx.computedFilterInputs(state);
  eq(cf.length, 1);
  eq(cf[0].name, "summary");
  eq(cf[0].filtered_rows.length, 2);
  // a filter on a table WITHOUT a filter_source is ignored
  ctx.ensureTableUi(state, "nofs", "computed");
  ctx.setColFilter(state, "nofs", "backend", "feldera");
  eq(ctx.computedFilterInputs(state).length, 1);
});

test("distinctScalarValues: sorted distinct, null for non-scalar columns", () => {
  eq(ctx.distinctScalarValues(ROWS, "backend"), ["feldera", "flowlog"]);
  eq(ctx.distinctScalarValues([{ x: 1 }, { x: undefined }, {}], "x"), ["", "1"]);
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
  assert.equal(state.ui.tables.runs.highlight, "lowest");
  assert.equal(ctx.setHighlight(state, "runs", "highest"), true);
  assert.equal(state.ui.tables.runs.highlight, "highest");
  assert.equal(ctx.setHighlight(state, "runs", "highest"), false);
});

test("toggleCheckbox edits the table's SQL box (clause for a column)", () => {
  const state = ctx.makeState({ runs: ROWS });
  // uncheck flowlog -> only feldera selected -> "backend = 'feldera'"
  ctx.toggleCheckbox(state, "runs", "backend", ["feldera"], ["feldera", "flowlog"]);
  assert.equal(state.ui.tables.runs.sql, "backend = 'feldera'");
  // re-check both -> clause removed
  ctx.toggleCheckbox(state, "runs", "backend", ["feldera", "flowlog"], ["feldera", "flowlog"]);
  assert.equal(state.ui.tables.runs.sql, "");
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

console.log(`\n${passed} tests passed`);
