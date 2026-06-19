/* Part of eval-live -- page wiring / entry point (initEvalLive).
   Loaded as a plain <script> (global functions, no ES modules): js() concatenates
   all modules into one inline tag; index.html loads them as separate <script src>. */

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
