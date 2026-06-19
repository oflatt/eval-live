/* Part of eval-live -- table rendering, per-column + SQL + checkbox filters, raw-table sync.
   Loaded as a plain <script> (global functions, no ES modules): js() concatenates
   all modules into one inline tag; index.html loads them as separate <script src>. */

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
