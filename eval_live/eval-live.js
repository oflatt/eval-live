/* =================================================================== *
 * SQL WHERE-clause filter, backed by AlaSQL (a real in-memory SQL engine,
 * vendored as the global `alasql` ahead of this file -- see eval_live.__init__).
 *
 * The per-table SQL filter box accepts an arbitrary SQL WHERE condition over
 * the row's columns (=, !=, <>, <, <=, >, >=, LIKE, IN, BETWEEN, AND/OR/NOT,
 * parentheses, ...) -- whatever AlaSQL's WHERE grammar supports -- and keeps
 * the rows for which it is true. We deliberately do NOT hand-roll a SQL parser;
 * AlaSQL evaluates the clause via `SELECT * FROM ? WHERE <clause>`.
 *
 * BACKWARD COMPATIBILITY: `sqlMatchSet` returns null when the text is not
 * a usable SQL condition -- a bare word like `feldera`, text typed mid-edit, or
 * anything AlaSQL rejects. Callers then fall back to the historic
 * substring-across-columns match, so plain-text filtering keeps working exactly
 * as before. A string is only treated as SQL when it actually contains a SQL
 * operator or keyword (see `looksLikeSql`). Note: unlike the old substring
 * filter, SQL string comparisons (e.g. `=`) are case-sensitive, matching real
 * SQL; use LIKE / UPPER(...) for case-insensitive matches.
 * =================================================================== */

// True only when the text uses a SQL operator/keyword; a bare word stays a
// substring match. Keeps `feldera` or a file path from being run as SQL.
function looksLikeSql(text) {
  return /(<=|>=|!=|<>|[<>=])|(\b(AND|OR|NOT|LIKE|IN|BETWEEN|IS|NULL)\b)/i.test(text);
}

/**
 * Evaluate a SQL WHERE clause over `rows` and return a Set of the indices that
 * match, or null if the text is not a usable SQL condition (caller falls back
 * to a substring match). Runs the clause ONCE via AlaSQL. A temporary index
 * column maps AlaSQL's result copies back to the originals.
 */
function sqlMatchSet(text, rows) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  if (!looksLikeSql(trimmed)) return null;
  if (typeof alasql !== "function") return null;  // engine missing -> fallback
  // `__el_idx` is unlikely to collide with a real column.
  const tagged = rows.map((r, i) => ({ ...r, __el_idx: i }));
  try {
    const res = alasql("SELECT __el_idx FROM ? WHERE " + trimmed, [tagged]);
    return new Set(res.map((r) => r.__el_idx));
  } catch (e) {
    return null;  // invalid / half-typed SQL -> substring fallback
  }
}

/* ---- Checkbox-clause helpers ------------------------------------- *
 * Checkbox dropdowns generate a clause like `backend IN ('a','b')` for a
 * column and merge it into the SQL filter box. A column's generated clause
 * is tracked verbatim (in `managedClauses`) so it can be found and replaced
 * without disturbing whatever else the user typed. */

function sqlQuote(v) {
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// The clause a set of checked values produces for a column. Empty checkedSet
// (or all-checked, handled by caller) means "no constraint" -> "".
function clauseForColumn(col, checkedValues) {
  if (checkedValues.length === 0) return "";
  if (checkedValues.length === 1) return `${col} = ${sqlQuote(checkedValues[0])}`;
  return `${col} IN (${checkedValues.map(sqlQuote).join(", ")})`;
}

/**
 * Render evaluation tables into a container element.
 * @param {HTMLElement|string} container - DOM element or element ID
 * @param {Object} data - Dict of table name -> array of row objects
 * @param {string} [name] - Project name shown in the heading
 * @param {string} [graphScript] - Python script that builds an eval_live.Registry
 * @param {string} [evalLivePy] - Source of the eval_live.py library
 */
function initEvalLive(container, data, name, graphScript, evalLivePy) {
  if (typeof container === "string") {
    container = document.getElementById(container);
  }
  container.classList.add("eval-live");
  container.innerHTML = "";

  if (name) {
    const h1 = document.createElement("h1");
    h1.className = "eval-live-title";
    h1.textContent = name + " \u2014 Eval Live";
    container.appendChild(h1);
  }

  // Shared state between initEvalLive and the Pyodide engine
  const state = {
    tableStates: [],
    computedTableStates: [],
    computedContainer: document.createElement("div"),
    originalData: data,
    onRawFilterChange: null,
    onComputedFilterChange: null,
  };

  let pyodideEngine = null;

  state.onRawFilterChange = function () {
    const filteredData = {};
    for (const ts of state.tableStates) {
      filteredData[ts.tableName] = ts.visibleRows;
    }
    if (pyodideEngine) {
      pyodideEngine.rerender(filteredData);
    }
  };

  state.onComputedFilterChange = function () {
    if (pyodideEngine) {
      pyodideEngine.applyComputedFilters();
    }
  };

  // Pyodide engine (graphs + computed tables)
  if (graphScript && evalLivePy) {
    const graphSection = document.createElement("div");
    graphSection.className = "graph-section";
    const graphStatus = document.createElement("div");
    graphStatus.className = "graph-status";
    graphStatus.textContent = "Loading Pyodide...";
    graphSection.appendChild(graphStatus);
    container.appendChild(graphSection);

    initPyodideEngine(graphSection, graphStatus, data, graphScript, evalLivePy, state).then((engine) => {
      pyodideEngine = engine;
    });
  }

  // Clear-all-filters button
  const clearBtn = document.createElement("button");
  clearBtn.className = "clear-filters-btn";
  clearBtn.textContent = "Clear all filters";
  clearBtn.addEventListener("click", () => {
    for (const ts of [...state.tableStates, ...state.computedTableStates]) {
      if (ts.resetFilters) {
        ts.resetFilters();           // clears column inputs + SQL box + checkboxes
      } else if (ts.filters) {
        let changed = false;
        for (const { input } of ts.filters) {
          if (input.value !== "") { input.value = ""; changed = true; }
        }
        if (changed && ts.applyFilters) ts.applyFilters();
      }
    }
  });
  container.appendChild(clearBtn);

  // Computed tables go before raw tables
  container.appendChild(state.computedContainer);

  const rawHeader = document.createElement("h2");
  rawHeader.className = "raw-tables-header";
  rawHeader.textContent = "Raw Tables";
  container.appendChild(rawHeader);

  for (const [tableName, rows] of Object.entries(data)) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const section = buildTable(tableName, rows, state.tableStates, state.onRawFilterChange);
    container.appendChild(section);
  }
}

/**
 * Build a table section DOM element.
 * @param {string} tableName
 * @param {Array} rows
 * @param {Array} tableStates - array to push state into
 * @param {Function} onFilterChange - called when filters change
 * @param {boolean} [filterable=true] - whether to show filter inputs
 * @returns {HTMLElement}
 */
function buildTable(tableName, rows, tableStates, onFilterChange, filterable) {
  if (filterable === undefined) filterable = true;
  const tableState = { tableName, rows, visibleRows: rows };
  tableStates.push(tableState);

  const section = document.createElement("div");
  section.className = "table-section";

  const heading = document.createElement("h2");
  heading.textContent = tableName;
  const rowCount = document.createElement("span");
  rowCount.className = "row-count";
  rowCount.textContent = `(${rows.length} rows)`;
  heading.appendChild(rowCount);
  section.appendChild(heading);

  const cols = [...new Set(rows.flatMap(Object.keys))];

  // --- SQL filter toolbar (one box + per-column checkbox dropdowns) -------
  // The SQL box is the single source of truth for the SQL-style filter that
  // drives the graphs (via onFilterChange). Checkbox dropdowns generate a
  // clause per column and merge it into the SQL box (one-way sync). The
  // per-column substring inputs (below) are ANDed on top, unchanged.
  let sqlInput = null;          // the SQL <input>, or null when not filterable
  const managedClauses = {};    // col -> last clause this column's checkboxes generated
  const checkboxGroups = [];    // { col, values, boxes:[{value, cb}] }

  if (filterable) {
    const toolbar = document.createElement("div");
    toolbar.className = "filter-toolbar";

    // SQL condition box
    const sqlWrap = document.createElement("div");
    sqlWrap.className = "sql-filter-wrap";
    sqlInput = document.createElement("input");
    sqlInput.type = "text";
    sqlInput.className = "sql-filter-input";
    sqlInput.placeholder =
      "SQL filter, e.g.  backend IN ('feldera','flowlog') AND mode = 'proofs'   (plain text = substring match)";
    sqlWrap.appendChild(sqlInput);
    const hint = document.createElement("span");
    hint.className = "sql-filter-hint";
    hint.textContent =
      "SQL WHERE clause:  = != <>  LIKE '%x%'  IN (...)  BETWEEN  AND/OR/NOT  ( )";
    hint.title =
      "Type a SQL WHERE condition over the columns (evaluated by AlaSQL). " +
      "Plain text with no SQL operator falls back to a substring match across " +
      "all columns. SQL string comparisons are case-sensitive; use LIKE for " +
      "case-insensitive matching.";
    sqlWrap.appendChild(hint);
    toolbar.appendChild(sqlWrap);

    // Per-column checkbox dropdowns for columns with < 30 distinct values.
    // Columns whose values are objects/arrays (non-scalar) are skipped.
    const dropdowns = document.createElement("div");
    dropdowns.className = "checkbox-dropdowns";
    for (const col of cols) {
      const distinct = new Set();
      let scalar = true;
      for (const r of rows) {
        const v = r[col];
        if (v !== undefined && v !== null && typeof v === "object") { scalar = false; break; }
        distinct.add(v === undefined || v === null ? "" : String(v));
      }
      if (!scalar) continue;
      if (distinct.size >= 30) continue;       // too many to checkbox; use typed SQL
      const values = [...distinct].sort();

      const details = document.createElement("details");
      details.className = "checkbox-dropdown";
      const summary = document.createElement("summary");
      summary.textContent = `${col} (${values.length})`;
      details.appendChild(summary);

      const list = document.createElement("div");
      list.className = "checkbox-list";
      const boxes = [];
      for (const value of values) {
        const label = document.createElement("label");
        label.className = "checkbox-item";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;            // all checked = no constraint
        const span = document.createElement("span");
        span.textContent = value === "" ? "(empty)" : value;
        label.appendChild(cb);
        label.appendChild(span);
        list.appendChild(label);
        boxes.push({ value, cb });
        cb.addEventListener("change", () => onCheckboxChange(col));
      }
      details.appendChild(list);
      dropdowns.appendChild(details);
      checkboxGroups.push({ col, values, boxes });
    }
    if (checkboxGroups.length > 0) toolbar.appendChild(dropdowns);

    section.appendChild(toolbar);
  }

  const table = document.createElement("table");

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const thExpand = document.createElement("th");
  thExpand.className = "expand-col";
  headerRow.appendChild(thExpand);
  for (const col of cols) {
    const th = document.createElement("th");
    th.textContent = col;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);

  // Filter row (only if filterable)
  const filters = [];
  if (filterable) {
    const filterRow = document.createElement("tr");
    filterRow.className = "filter-row";
    const filterExpandTh = document.createElement("th");
    filterExpandTh.className = "expand-col";
    filterRow.appendChild(filterExpandTh);
    for (const col of cols) {
      const th = document.createElement("th");
      const input = document.createElement("input");
      input.type = "text";
      input.className = "filter-input";
      input.placeholder = "filter...";
      filters.push({ col, input });
      th.appendChild(input);
      filterRow.appendChild(th);
    }
    thead.appendChild(filterRow);
  }
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const rowEls = [];
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.classList.add("collapsed");

    const tdBtn = document.createElement("td");
    tdBtn.className = "expand-col";
    const btn = document.createElement("button");
    btn.className = "expand-btn";
    btn.textContent = "+";
    btn.addEventListener("click", () => {
      const collapsed = tr.classList.toggle("collapsed");
      btn.textContent = collapsed ? "+" : "\u2212";
    });
    tdBtn.appendChild(btn);
    tr.appendChild(tdBtn);

    for (const col of cols) {
      const td = document.createElement("td");
      const val = row[col];
      td.textContent = val === undefined ? "" : typeof val === "object" ? JSON.stringify(val) : String(val);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
    rowEls.push({ tr, row });
  }

  function applyFilters() {
    // SQL box: evaluate as a SQL WHERE clause (via AlaSQL) once over all rows.
    // Plain text (no SQL operators) is treated as a substring match across all
    // columns (backward compatible); an invalid/half-typed SQL string also
    // falls back to substring so the user never gets an empty table mid-edit.
    const sqlText = sqlInput ? sqlInput.value.trim() : "";
    const sqlSet = sqlText ? sqlMatchSet(sqlText, rows) : null;
    const sqlSubstr = (sqlText && !sqlSet) ? sqlText.toLowerCase() : null;

    let visible = 0;
    const filtered = [];
    for (let i = 0; i < rowEls.length; i++) {
      const { tr, row } = rowEls[i];
      let show = true;
      // Per-column substring inputs (ANDed), unchanged behavior.
      for (const { col, input } of filters) {
        const query = input.value.toLowerCase();
        if (!query) continue;
        const val = row[col];
        const text = val === undefined ? "" : typeof val === "object" ? JSON.stringify(val) : String(val);
        if (!text.toLowerCase().includes(query)) { show = false; break; }
      }
      // SQL box (ANDed on top of the per-column inputs).
      if (show && sqlSet) {
        if (!sqlSet.has(i)) show = false;
      } else if (show && sqlSubstr) {
        const text = cols.map((c) => {
          const v = row[c];
          return v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
        }).join(" ").toLowerCase();
        if (!text.includes(sqlSubstr)) show = false;
      }
      tr.style.display = show ? "" : "none";
      if (show) { visible++; filtered.push(row); }
    }
    rowCount.textContent = `(${visible}/${rows.length} rows)`;
    tableState.visibleRows = filtered;
    onFilterChange();
  }
  for (const { input } of filters) {
    input.addEventListener("input", applyFilters);
  }

  // --- Checkbox <-> SQL box sync ----------------------------------------
  // onCheckboxChange (checkbox -> SQL): regenerate this column's clause and
  // splice it into the SQL box, replacing the clause it generated last time
  // (so re-checking does not accumulate duplicates). Clauses from different
  // columns combine with AND. All-checked means "no constraint" for a column.
  function onCheckboxChange(col) {
    const group = checkboxGroups.find((g) => g.col === col);
    if (!group || !sqlInput) return;
    const checked = group.boxes.filter((b) => b.cb.checked).map((b) => b.value);
    const newClause = checked.length === group.values.length
      ? ""                                  // all checked -> no constraint
      : clauseForColumn(col, checked);      // "" when none checked, too
    sqlInput.value = spliceClause(sqlInput.value, col, newClause);
    applyFilters();
  }

  // Replace the previously-generated clause for `col` (tracked in
  // managedClauses) with `newClause` inside the current SQL text, removing one
  // adjacent AND so no dangling glue is left. With no prior managed clause,
  // append the new one with AND. An empty newClause just removes the column's
  // clause (used when all values are checked again).
  function spliceClause(current, col, newClause) {
    const prev = managedClauses[col];
    let text = current;
    if (prev) {
      const esc = prev.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Match "prev AND", "AND prev", or a bare "prev" and substitute.
      const re = new RegExp(`(\\s*AND\\s+)?${esc}(\\s+AND\\s*)?`, "i");
      if (re.test(text)) {
        text = text.replace(re, (full, before, after) =>
          newClause ? `${before || ""}${newClause}${after || ""}`
                    : (before && after ? " AND " : ""));
      } else if (newClause) {
        text = text.trim() ? `${text.trim()} AND ${newClause}` : newClause;
      }
    } else if (newClause) {
      text = text.trim() ? `${text.trim()} AND ${newClause}` : newClause;
    }
    managedClauses[col] = newClause || null;
    // Tidy doubled / dangling AND glue.
    text = text
      .replace(/^\s*AND\s+/i, "")
      .replace(/\s+AND\s*$/i, "")
      .replace(/\s+AND(\s+AND)+\s+/gi, " AND ")
      .replace(/\s+/g, " ")
      .trim();
    return text;
  }

  // SQL box -> checkboxes (two-way, best-effort): when the user edits the SQL
  // box directly, re-derive checkbox states from simple `col = '...'` /
  // `col IN ('a','b')` clauses we can recognize. Anything more complex leaves
  // the checkboxes as-is (the SQL box still wins for filtering).
  function syncCheckboxesFromSql() {
    if (!sqlInput) return;
    const text = sqlInput.value;
    for (const group of checkboxGroups) {
      const col = group.col;
      const wanted = extractColumnValues(text, col); // null = not constrained
      if (wanted === null) {
        // No recognizable clause for this column -> show all as checked.
        for (const b of group.boxes) b.cb.checked = true;
        managedClauses[col] = null;
      } else {
        const set = new Set(wanted.map((v) => v.toLowerCase()));
        for (const b of group.boxes) b.cb.checked = set.has(String(b.value).toLowerCase());
        const checked = group.boxes.filter((b) => b.cb.checked).map((b) => b.value);
        managedClauses[col] =
          checked.length === group.values.length ? null : clauseForColumn(col, checked);
      }
    }
  }

  // Recognize `col = 'v'` or `col IN ('a','b',...)` (case-insensitive col,
  // single-quoted values). Returns the value list, or null if no such clause.
  function extractColumnValues(text, col) {
    const c = col.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const inRe = new RegExp(`\\b${c}\\s+IN\\s*\\(([^)]*)\\)`, "i");
    const eqRe = new RegExp(`\\b${c}\\s*=\\s*'((?:[^']|'')*)'`, "i");
    let m = inRe.exec(text);
    if (m) {
      const vals = [];
      const re = /'((?:[^']|'')*)'/g;
      let mm;
      while ((mm = re.exec(m[1])) !== null) vals.push(mm[1].replace(/''/g, "'"));
      return vals;
    }
    m = eqRe.exec(text);
    if (m) return [m[1].replace(/''/g, "'")];
    return null;
  }

  if (sqlInput) {
    sqlInput.addEventListener("input", () => {
      syncCheckboxesFromSql();
      applyFilters();
    });
  }

  table.appendChild(tbody);
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  wrap.appendChild(table);
  section.appendChild(wrap);

  tableState.applyFilters = applyFilters;
  tableState.rowEls = rowEls;
  tableState.rowCount = rowCount;
  tableState.filters = filters;
  tableState.sqlInput = sqlInput;
  // Reset everything this table owns: per-column inputs, the SQL box, and the
  // checkbox dropdowns (back to all-checked). Used by "Clear all filters".
  tableState.resetFilters = function () {
    let changed = false;
    for (const { input } of filters) {
      if (input.value !== "") { input.value = ""; changed = true; }
    }
    if (sqlInput && sqlInput.value !== "") { sqlInput.value = ""; changed = true; }
    for (const group of checkboxGroups) {
      for (const b of group.boxes) {
        if (!b.cb.checked) { b.cb.checked = true; changed = true; }
      }
      managedClauses[group.col] = null;
    }
    if (changed) applyFilters();
    return changed;
  };

  return section;
}

/**
 * Show/hide rows in a raw table based on filtered data from apply_table_filters.
 * @param {Object} filteredData - {tableName: [rows]}
 * @param {Array} rawTableStates
 */
function applyFilteredDataToRawTables(filteredData, rawTableStates) {
  for (const ts of rawTableStates) {
    const allowed = filteredData[ts.tableName];
    if (!allowed) continue;
    const allowedSet = new Set(allowed.map(r => JSON.stringify(r)));
    const filtered = [];
    for (const { tr, row } of ts.rowEls) {
      const show = allowedSet.has(JSON.stringify(row));
      tr.style.display = show ? "" : "none";
      if (show) filtered.push(row);
    }
    ts.visibleRows = filtered;
    ts.rowCount.textContent = `(${filtered.length}/${ts.rows.length} rows)`;
  }
}

async function initPyodideEngine(section, status, data, graphScript, evalLivePy, state) {
  try {
    const pyodide = await loadPyodide();
    status.textContent = "Installing matplotlib...";
    await pyodide.loadPackage("matplotlib");
    status.textContent = "Running graph script...";

    pyodide.FS.writeFile("/home/pyodide/eval_live.py", evalLivePy);
    await pyodide.runPythonAsync(graphScript);

    // Graph UI
    const bar = document.createElement("div");
    bar.className = "graph-bar";
    section.appendChild(bar);
    const display = document.createElement("div");
    display.className = "graph-display";
    section.appendChild(display);

    let activeGraphName = null;

    async function renderGraphs(inputData) {
      pyodide.globals.set("__eval_live_data__", pyodide.toPy(inputData));
      const resultProxy = await pyodide.runPythonAsync(
        "import eval_live; eval_live.registry.run_graphs(__eval_live_data__)"
      );
      const graphs = resultProxy.toJs({ create_proxies: false });
      resultProxy.destroy();
      return graphs;
    }

    async function renderTables(inputData) {
      pyodide.globals.set("__eval_live_data__", pyodide.toPy(inputData));
      const resultProxy = await pyodide.runPythonAsync(
        "import eval_live; eval_live.registry.run_tables(__eval_live_data__)"
      );
      const tables = resultProxy.toJs({ create_proxies: false });
      resultProxy.destroy();
      return tables.map(t => ({
        name: t.get("name"),
        rows: t.get("rows").map(r => Object.fromEntries(r.entries())),
        hasFilterSource: t.get("has_filter_source"),
      }));
    }

    async function callApplyTableFilters(tableFilters, inputData) {
      pyodide.globals.set("__eval_live_data__", pyodide.toPy(inputData));
      pyodide.globals.set("__eval_live_table_filters__", pyodide.toPy(tableFilters));
      const resultProxy = await pyodide.runPythonAsync(
        "import eval_live; eval_live.registry.apply_table_filters(__eval_live_table_filters__, __eval_live_data__)"
      );
      const result = resultProxy.toJs({ create_proxies: false });
      resultProxy.destroy();
      // Convert to plain JS object
      const out = {};
      for (const [k, v] of result.entries()) {
        if (Array.isArray(v)) {
          out[k] = v.map(r => r instanceof Map ? Object.fromEntries(r.entries()) : r);
        } else {
          out[k] = v;
        }
      }
      return out;
    }

    async function showGraphs(inputData) {
      const graphs = await renderGraphs(inputData);
      if (!graphs || graphs.length === 0) {
        status.textContent = "No graphs registered.";
        return;
      }

      const graphMap = new Map();
      for (const g of graphs) {
        graphMap.set(g.get("name"), g.get("src"));
      }

      // Always rebuild buttons and display
      bar.innerHTML = "";
      display.innerHTML = "";

      for (const g of graphs) {
        const gName = g.get("name");
        const btn = document.createElement("button");
        btn.className = "graph-btn";
        btn.textContent = gName;
        btn.addEventListener("click", () => {
          for (const b of bar.querySelectorAll(".graph-btn")) b.classList.remove("active");
          btn.classList.add("active");
          activeGraphName = gName;
          display.innerHTML = "";
          const src = graphMap.get(gName);
          if (src) {
            const img = document.createElement("img");
            img.src = src;
            img.alt = gName;
            display.appendChild(img);
          }
        });
        bar.appendChild(btn);
      }

      // Preserve active selection, or default to first
      const selected = activeGraphName && graphMap.has(activeGraphName)
        ? activeGraphName
        : graphs[0].get("name");
      activeGraphName = selected;
      for (const btn of bar.querySelectorAll(".graph-btn")) {
        if (btn.textContent === selected) { btn.click(); break; }
      }
    }

    // Track which computed tables have filter_source
    let computedTableMeta = [];

    async function showComputedTables(inputData) {
      const tables = await renderTables(inputData);

      state.computedContainer.innerHTML = "";
      state.computedTableStates.length = 0;
      computedTableMeta = tables.map(t => ({
        name: t.name,
        hasFilterSource: t.hasFilterSource,
      }));

      for (const { name, rows, hasFilterSource } of tables) {
        if (!rows || rows.length === 0) continue;
        const sect = buildTable(name, rows, state.computedTableStates, state.onComputedFilterChange, hasFilterSource);
        state.computedContainer.appendChild(sect);
      }
    }

    /**
     * Called when a computed table's text filter changes.
     * Collects visible rows from all computed tables that have filter_source,
     * calls apply_table_filters in Python to get filtered raw data,
     * then applies that to the raw table DOM.
     */
    async function applyComputedFilters() {
      // Build table_filters list for Python
      const tableFilters = [];
      for (const ct of state.computedTableStates) {
        const meta = computedTableMeta.find(m => m.name === ct.tableName);
        if (meta && meta.hasFilterSource) {
          tableFilters.push({ name: ct.tableName, filtered_rows: ct.visibleRows });
        }
      }

      if (tableFilters.length === 0) return;

      const filteredData = await callApplyTableFilters(tableFilters, state.originalData);
      applyFilteredDataToRawTables(filteredData, state.tableStates);
    }

    // Initial render
    status.textContent = "";
    await showGraphs(data);
    await showComputedTables(data);

    // Debounced re-render for raw filter changes
    let rerenderTimer = null;
    function rerender(filteredData) {
      clearTimeout(rerenderTimer);
      rerenderTimer = setTimeout(async () => {
        // Re-run script to rebuild the registry
        pyodide.runPython("import eval_live; eval_live.registry = None");
        await pyodide.runPythonAsync(graphScript);
        await showGraphs(filteredData);
        await showComputedTables(filteredData);
      }, 300);
    }

    return { rerender, applyComputedFilters };
  } catch (err) {
    status.textContent = "Graph error: " + err.message;
    console.error(err);
    return null;
  }
}
