/* One table's controls and results. Controls keep their DOM identity while
   sync(state) replaces the result rows. User choices live in state.ui; expanded
   rows are local display state. Loaded after state.js. */

/**
 * Create a table view and its persistent controls.
 *
 * update(rows, optionRows) supplies a calculation's results and the rows from
 * before computed narrowing. sync(state) redraws using current controls.
 * Pending/failed computed results are hidden; raw rows also wait when a
 * computed filter may narrow them. Active filters remain editable with no rows.
 *
 * handlers: onToggleCollapse(name, kind), onSql(name, value, kind),
 * onColFilter(name, column, value, kind), onHighlight(name, mode, kind),
 * onCheckbox(name, column, checkedValues, allValues, kind).
 */
function buildTableView(name, rows, kind, filterable, description, handlers, optionRows = rows) {
  function element(tag, className, parent, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  // Leave controls in place when their order is unchanged, preserving focus.
  function place(parent, node, index) {
    if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null);
  }

  const section = element("div", "table-section");
  const heading = element("h2", "table-heading", section);
  element("span", "collapse-caret", heading, "▾");
  element("span", "table-title", heading, name);
  const rowCount = element("span", "row-count", heading);
  heading.addEventListener("click", () => handlers.onToggleCollapse(name, kind));
  if (description) element("p", "table-description", section, description);

  const controls = element("div", "table-controls", section);
  const hlLabel = element("label", "highlight-control", controls, "Highlight # per row: ");
  const hlSelect = element("select", null, hlLabel);
  for (const mode of ["lowest", "highest", "none"]) {
    element("option", null, hlSelect, mode).value = mode;
  }
  hlSelect.addEventListener("change", () => handlers.onHighlight(name, hlSelect.value, kind));

  let sqlInput, dropdowns;
  if (filterable) {
    const toolbar = element("div", "filter-toolbar", section);
    const sqlWrap = element("div", "sql-filter-wrap", toolbar);
    sqlInput = element("input", "sql-filter-input", sqlWrap);
    sqlInput.type = "text";
    sqlInput.placeholder = "SQL filter, e.g. size >= 100 AND status = 'success' (or plain text)";
    sqlInput.addEventListener("input", () => handlers.onSql(name, sqlInput.value, kind));
    element("span", "sql-filter-hint", sqlWrap,
      "SQL or text, column text, and checkbox filters apply together. Clear all filters resets them.");
    dropdowns = element("div", "checkbox-dropdowns", toolbar);
  }

  const wrap = element("div", "table-wrap", section);
  const table = element("table", null, wrap);
  const thead = element("thead", null, table);
  const header = element("tr", null, thead);
  element("th", "expand-col", header);
  const filterRow = filterable ? element("tr", "filter-row", thead) : null;
  if (filterRow) element("th", "expand-col", filterRow);
  const tbody = element("tbody", null, table);
  const columns = new Map();
  const expanded = new Set();
  let cols = columnsOf([...rows, ...optionRows]);

  function update(newRows, newOptions = newRows) {
    rows = newRows;
    optionRows = newOptions;
    // Keep controls available when a calculation returns no rows.
    const names = columnsOf([...rows, ...optionRows]);
    if (names.length) cols = names;
  }

  function syncColumns(ui) {
    const names = [...new Set([...cols, ...Object.keys(ui.colFilters), ...Object.keys(ui.checkedValues)])];
    for (const [col, control] of columns) {
      if (names.includes(col)) continue;
      control.th.remove();
      if (control.filter) control.filter.remove();
      if (control.details) control.details.remove();
      columns.delete(col);
    }
    names.forEach((col, index) => {
      let control = columns.get(col);
      if (!control) {
        control = {th: element("th", null, null, col), boxes: new Map()};
        if (filterable) {
          control.filter = element("th");
          control.input = element("input", "filter-input", control.filter);
          control.input.placeholder = "filter...";
          control.input.addEventListener("input", () => handlers.onColFilter(name, col, control.input.value, kind));
          control.details = element("details", "checkbox-dropdown");
          control.summary = element("summary", null, control.details);
          control.list = element("div", "checkbox-list", control.details);
        }
        columns.set(col, control);
      }
      place(header, control.th, index + 1);
      if (!filterable) return;
      place(filterRow, control.filter, index + 1);
      if (document.activeElement !== control.input) {
        control.input.value = Object.hasOwn(ui.colFilters, col) ? ui.colFilters[col] : "";
      }
      const available = distinctScalarValues(optionRows, col);
      const selected = Object.hasOwn(ui.checkedValues, col) ? ui.checkedValues[col] : null;
      if ((!available || available.length >= 30) && !selected) {
        control.details.remove();
        return;
      }
      // Keep selected values visible even if another filter removes their rows.
      control.values = [...new Set([...(available || []), ...(selected || [])])];
      control.summary.textContent = `${col} (${control.values.length})`;
      for (const [value, box] of control.boxes) {
        if (!control.values.includes(value)) { box.label.remove(); control.boxes.delete(value); }
      }
      control.values.forEach((value, position) => {
        let box = control.boxes.get(value);
        if (!box) {
          const label = element("label", "checkbox-item");
          const cb = element("input", null, label);
          cb.type = "checkbox";
          element("span", null, label, value === null ? "(null / missing)" : value === "" ? "(empty string)"
            : typeof value === "string" ? JSON.stringify(value) : String(value));
          box = {label, cb};
          control.boxes.set(value, box);
          cb.addEventListener("change", () => handlers.onCheckbox(name, col,
            control.values.filter(v => control.boxes.get(v).cb.checked), control.values, kind));
        }
        box.cb.checked = !selected || selected.includes(value);
        place(control.list, box.label, position);
      });
      // Other columns may have no dropdown, so position among existing controls.
      const previous = names.slice(0, index).filter(c => columns.get(c).details?.parentNode === dropdowns).length;
      place(dropdowns, control.details, previous);
    });
    return names;
  }

  function sync(state) {
    const ui = state.ui.tables[tableKey(name, kind)] || makeTableUi(kind);
    section.classList.toggle("collapsed", !!ui.collapsed);
    hlSelect.value = ui.highlight;
    if (filterable && document.activeElement !== sqlInput) sqlInput.value = ui.sql;
    const names = syncColumns(ui);
    const hasComputedFilter = Object.values(state.ui.tables).some(control => control.kind === "computed" && hasFilters(control));
    const pending = (kind !== "raw" || hasComputedFilter) && state.graphScript && state.engine.status !== "ready";
    const allowedRows = kind === "raw" && state.engine.narrowing?.[name];
    const allowed = allowedRows ? narrowedKeySet(allowedRows) : null;
    const visible = pending ? [] : visibleRowIndices(rows, names, ui)
      .filter(i => !allowed || allowed.has(rowKey(rows[i])));

    tbody.innerHTML = "";
    for (const i of visible) {
      const row = rows[i], key = rowKey(row);
      const tr = element("tr", expanded.has(key) ? "" : "collapsed", tbody);
      const btn = element("button", "expand-btn", element("td", "expand-col", tr), expanded.has(key) ? "−" : "+");
      btn.addEventListener("click", () => {
        const collapsed = tr.classList.toggle("collapsed");
        if (collapsed) expanded.delete(key); else expanded.add(key);
        btn.textContent = collapsed ? "+" : "−";
      });
      const best = bestNumericCols(row, names, ui.highlight);
      for (const col of names) {
        const value = row[col];
        const td = element("td", best.has(col) ? "cell-best" : null, tr, cellText(value));
        if (value !== null && typeof value === "object" && value.style) applyCellStyle(td, value.style);
      }
    }
    rowCount.textContent = pending ? (state.engine.status === "error" ? "(unavailable)" : "(updating)")
      : visible.length === rows.length ? `(${rows.length} rows)` : `(${visible.length}/${rows.length} rows)`;
  }

  // Construct headings and rows for callers that use this view directly.
  sync({ui: {tables: {}}, engine: {}, graphScript: null});
  return {name, kind, section, update, sync};
}
