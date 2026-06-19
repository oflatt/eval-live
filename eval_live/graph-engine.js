/* Part of eval-live -- Pyodide graph + computed-table engine.
   Loaded as a plain <script> (global functions, no ES modules): js() concatenates
   all modules into one inline tag; index.html loads them as separate <script src>. */

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
