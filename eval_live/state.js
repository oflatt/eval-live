/* Viewer state, pure filtering helpers, and synchronous reducers.
   state.data is fixed for the viewer's lifetime. state.ui holds current controls;
   the engine copies these controls for each calculation and publishes derived
   outputs in state.engine. Reducers change the live state and report whether it
   changed; eval-live.js decides whether to redraw or request a calculation.
   No DOM or asynchronous work belongs here. Loaded as a plain script after
   sql-filter.js (sqlMatchSet); tested in test/state.test.mjs. */

// ---- construction ---------------------------------------------------------

function makeTableUi(kind) {
  // SQL, column substrings, and typed checkbox selections are independent
  // constraints. A row must pass all three. Missing checkbox keys allow all values.
  // highlight: which numeric cell to mark per row -- "lowest" | "highest" | "none".
  return { kind: kind, collapsed: false, sql: "", colFilters: {}, checkedValues: {}, highlight: "lowest" };
}

/**
 * Create viewer state for named row tables. Retains data as supplied; callers
 * must not mutate it. Rejects whole numbers outside the browser's exact range.
 */
function makeState(data, projectName, graphScript, evalLivePy) {
  browserNumbers(data);
  const tables = {};
  for (const name of Object.keys(data)) {
    const rows = data[name];
    if (Array.isArray(rows) && rows.length > 0) tables[tableKey(name, "raw")] = makeTableUi("raw");
  }
  return {
    data: data,
    projectName: projectName || null,
    graphScript: graphScript || null,
    evalLivePy: evalLivePy || null,
    ui: {
      tables: tables,        // tableKey(name, kind) -> controls for that table
      activeGraph: null,     // selected graph name (null = first available)
    },
    engine: {
      // "none" when no graph script; otherwise "loading" -> "ready" | "error".
      status: graphScript ? "loading" : "none",
      statusText: "",
      graphs: [],            // [{name, src}]
      // computedUnfiltered: tables run on rawFilteredData (raw filters only) --
      //   the source for checkbox OPTIONS and for the narrowing SELECTION.
      //   Computing the selection from these (not the displayed ones) is what
      //   keeps the data-flow acyclic.
      // computedTables: tables run on the effective (narrowed) data -- what the
      //   views actually DISPLAY, so one computed filter narrows them all.
      computedUnfiltered: [], // [{name, rows, hasInteractiveFilter}]
      computedTables: [],     // [{name, rows, hasInteractiveFilter}]
      messages: [],           // derived warnings/errors; never part of raw data
      narrowing: null,        // {tableName: rows[]} from computed->raw feedback, or null
    },
  };
}

// Validate nested display values without coercion. Larger integer identifiers
// must be strings; accepting a rounded number here would corrupt later filtering.
function browserNumbers(value) {
  if (typeof value === "bigint" ||
      (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value))) {
    throw new Error("Integer exceeds the browser's exact range; use a string for identifiers");
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) browserNumbers(item);
  }
}

// Raw, computed, and diagnostic tables may share a display name.
function tableKey(name, kind = "raw") {
  return JSON.stringify([kind, name]);
}

// Equal display names in different sections have independent controls.
function ensureTableUi(state, name, kind = "raw") {
  const key = tableKey(name, kind);
  if (!state.ui.tables[key]) state.ui.tables[key] = makeTableUi(kind);
  return state.ui.tables[key];
}

// ---- pure helpers ---------------------------------------------------------

// Cell -> text, matching the historic rendering exactly (null -> "null" via
// JSON.stringify; undefined -> ""). A styled cell ({text, style}) renders its
// text; the style drives a CSS class in the table view, not the text.
function cellText(val) {
  if (val === undefined) return "";
  if (val !== null && typeof val === "object" && "text" in val) {
    return val.text === null || val.text === undefined ? "" : String(val.text);
  }
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

function columnsOf(rows) {
  return [...new Set(rows.flatMap(Object.keys))];
}

// Apply a styled cell's visual `style` to a <td>. `style` is a dict with any of
// {color, bold, dim}, or a plain string used as the color. eval-live only
// applies visual attributes; what a style signifies is up to the caller.
function applyCellStyle(td, style) {
  if (!style) return;
  if (typeof style === "string") { td.style.color = style; return; }
  if (style.color) td.style.color = style.color;
  if (style.bold) td.style.fontWeight = "600";
  if (style.dim) td.style.opacity = "0.65";
}

// Indices of rows passing all checkbox, column text, and SQL constraints.
// The SQL box is evaluated once over all rows via AlaSQL (sqlMatchSet);
// plain/invalid text falls back to a substring match across all columns.
function visibleRowIndices(rows, cols, ui) {
  const sqlText = (ui.sql || "").trim();
  const sqlSet = sqlText ? sqlMatchSet(sqlText, rows) : null;
  const sqlSubstr = (sqlText && !sqlSet) ? sqlText.toLowerCase() : null;
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let show = Object.entries(ui.checkedValues || {}).every(([col, values]) =>
      values.includes(row[col] === undefined ? null : row[col]));
    for (const col of cols) {
      const q = (Object.hasOwn(ui.colFilters, col) ? ui.colFilters[col] : "").toLowerCase();
      if (!q) continue;
      if (!cellText(row[col]).toLowerCase().includes(q)) { show = false; break; }
    }
    if (show && sqlSet) {
      if (!sqlSet.has(i)) show = false;
    } else if (show && sqlSubstr) {
      const joined = cols.map((c) => cellText(row[c])).join(" ").toLowerCase();
      if (!joined.includes(sqlSubstr)) show = false;
    }
    if (show) out.push(i);
  }
  return out;
}

function visibleRows(rows, ui) {
  return visibleRowIndices(rows, columnsOf(rows), ui).map((i) => rows[i]);
}

// Apply each raw table's own controls, retaining empty tables. Input narrowing
// is excluded here: these rows determine the computed selections that narrow it.
function rawFilteredData(state) {
  const out = {};
  for (const name of Object.keys(state.data)) {
    const rows = state.data[name];
    const ui = state.ui.tables[tableKey(name)];
    if (!Array.isArray(rows)) continue;
    out[name] = ui ? visibleRows(rows, ui) : rows;
  }
  return out;
}

// Intersect raw-filtered rows with the interactive filters' allowed rows.
// An omitted table keeps its rows; an empty allowed list removes all of them.
// Used for displayed tables and graphs; cannot reintroduce a raw-filtered row.
function effectiveRawData(state) {
  const fd = rawFilteredData(state);
  const narrowing = state.engine.narrowing;
  if (!narrowing) return fd;
  const out = {};
  for (const name of Object.keys(fd)) {
    const allowedRows = narrowing[name];
    if (allowedRows) {
      const allowed = narrowedKeySet(allowedRows);
      out[name] = fd[name].filter((r) => allowed.has(rowKey(r)));
    } else {
      out[name] = fd[name];
    }
  }
  return out;
}

// {name, filtered_rows} for every computed table that has an interactive_filter AND
// an active filter -- the input to apply_table_filters (the computed->raw
// narrowing). The selection is taken from the UNFILTERED tables so it does not
// depend on the narrowing (no cycle). Tables with no active filter are omitted,
// so with nothing filtered this returns [] and the narrowing stays null.
function computedFilterInputs(state) {
  const out = [];
  for (const t of state.engine.computedUnfiltered) {
    if (!t.hasInteractiveFilter) continue;
    const ui = state.ui.tables[tableKey(t.name, "computed")];
    if (!ui) continue;
    if (!hasFilters(ui)) continue;
    out.push({ name: t.name, filtered_rows: visibleRows(t.rows, ui) });
  }
  return out;
}

// Sorted distinct values of a column, or null if any value is a non-scalar
// (object/array) -- such columns get no checkbox dropdown. Pure so the dropdown
// list can be derived (and tested) rather than computed ad hoc in the view.
// Preserve scalar types; missing cells and null share one option.
function distinctScalarValues(rows, col) {
  const distinct = new Set();
  for (const r of rows) {
    const v = r[col];
    if (v !== undefined && v !== null && typeof v === "object") return null;
    distinct.add(v === undefined ? null : v);
  }
  return [...distinct].sort((a, b) => String(a).localeCompare(String(b)) || (typeof a).localeCompare(typeof b));
}

// Identify JSON rows by their complete contents, independent of object key order.
// Both graph inputs and visible raw rows use this equality when narrowing data.
function rowKey(row) {
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  }
  return JSON.stringify(canonical(row));
}
function narrowedKeySet(rows) {
  return new Set(rows.map(rowKey));
}

// A cell counts as numeric if it is a finite number or a string that parses as
// one (results.json often carries numbers as strings).
function isNumericValue(v) {
  if (typeof v === "number") return isFinite(v);
  if (typeof v === "string" && v.trim() !== "") return isFinite(Number(v));
  return false;
}

// The columns whose value is the best number in `row` for the given `mode`
// ("lowest" default | "highest" | "none"). Used to highlight the best value per
// row. Only highlights when the row has >= 2 numeric cells, so a lone number
// isn't pointlessly marked. Ties all highlight. Returns a Set of column names.
function bestNumericCols(row, cols, mode) {
  if (mode === "none") return new Set();
  const highest = mode === "highest";
  const nums = [];
  for (const col of cols) if (isNumericValue(row[col])) nums.push({ col, n: Number(row[col]) });
  if (nums.length < 2) return new Set();
  let best = highest ? -Infinity : Infinity;
  for (const x of nums) best = highest ? Math.max(best, x.n) : Math.min(best, x.n);
  return new Set(nums.filter((x) => x.n === best).map((x) => x.col));
}

// True when any input constraint is active, including checkbox-only selections.
function hasFilters(ui) {
  return !!(ui.sql.trim() || Object.keys(ui.colFilters).length || Object.keys(ui.checkedValues).length);
}

// ---- reducers (mutate state in place; return true if something changed) ----

function toggleCollapsed(state, name, kind = "raw") {
  const ui = ensureTableUi(state, name, kind);
  ui.collapsed = !ui.collapsed;
  return true;
}

function setSql(state, name, sql, kind = "raw") {
  const ui = ensureTableUi(state, name, kind);
  if (ui.sql === sql) return false;
  ui.sql = sql;
  return true;
}

function setColFilter(state, name, col, value, kind = "raw") {
  const ui = ensureTableUi(state, name, kind);
  const cur = Object.hasOwn(ui.colFilters, col) ? ui.colFilters[col] : "";
  if (cur === (value || "")) return false;
  if (value) ui.colFilters = {...ui.colFilters, [col]: value}; else delete ui.colFilters[col];
  return true;
}

function setActiveGraph(state, name) {
  if (state.ui.activeGraph === name) return false;
  state.ui.activeGraph = name;
  return true;
}

// All checked or none checked removes the constraint; SQL text is unchanged.
function toggleCheckbox(state, name, col, checked, all, kind = "raw") {
  const ui = ensureTableUi(state, name, kind);
  if (!checked.length || checked.length === all.length) delete ui.checkedValues[col];
  else ui.checkedValues = {...ui.checkedValues, [col]: [...checked]};
  return true;
}

// The graph to show: the chosen one if it still exists, else the first. Pure so
// the view is a straight read rather than carrying the fallback logic. `graphs`
// is state.engine.graphs ([{name, ...}]).
function resolveActiveGraph(state) {
  const names = state.engine.graphs.map((g) => g.name);
  if (state.ui.activeGraph && names.includes(state.ui.activeGraph)) return state.ui.activeGraph;
  return names[0] || null;
}

function setHighlight(state, name, mode, kind = "raw") {
  const ui = ensureTableUi(state, name, kind);
  if (ui.highlight === mode) return false;
  ui.highlight = mode;
  return true;
}

function clearAllFilters(state) {
  let changed = false;
  for (const name of Object.keys(state.ui.tables)) {
    const ui = state.ui.tables[name];
    if (ui.sql) { ui.sql = ""; changed = true; }
    if (Object.keys(ui.colFilters).length) { ui.colFilters = {}; changed = true; }
    if (Object.keys(ui.checkedValues).length) { ui.checkedValues = {}; changed = true; }
  }
  return changed;
}

// Export for node tests only; harmless in the browser (no module global there).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    makeState, makeTableUi, tableKey, ensureTableUi, cellText, columnsOf,
    visibleRowIndices, visibleRows, rawFilteredData, effectiveRawData,
    computedFilterInputs, distinctScalarValues, rowKey, narrowedKeySet,
    isNumericValue, bestNumericCols,
    hasFilters,
    toggleCollapsed, setSql, setColFilter, setActiveGraph, toggleCheckbox,
    resolveActiveGraph, setHighlight, clearAllFilters,
  };
}
