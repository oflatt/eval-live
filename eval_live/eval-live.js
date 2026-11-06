/* Own the viewer state and connect controls, calculations, and the DOM.
   Filter edits request an engine calculation. Engine status/results and display
   controls only redraw the view, so publishing results cannot trigger a loop.
   Table controls live in state.ui and survive replacement of computed rows.
   Loaded after state.js, table-view.js, and graph-engine.js as a plain script. */

/**
 * Render evaluation tables (and, when a graph script is supplied, Pyodide graphs
 * + computed tables) into a container.
 *
 * Keep data unchanged after initialization. Both graphScript and evalLivePy are
 * needed for Python outputs; raw tables work without them. Whole numbers outside
 * JavaScript's exact integer range raise an error instead of being displayed.
 *
 * @param {HTMLElement|string} container
 * @param {Object} data - { tableName: rows[] }
 * @param {string} [name] - project name shown in the heading
 * @param {string} [graphScript] - Python building an eval_live.Registry
 * @param {string} [evalLivePy] - source of eval_live.py
 * @param {Object.<string,string>} [extraModules] - {filename: source} extra
 *   Python modules written to the Pyodide filesystem, importable by graphScript
 * @returns {Object} getState() exposes current state; updateFilters(mutator)
 *   applies an input change and requests calculation. setState(mutator) and
 *   render() redraw presentation without running Python.
 */
function initEvalLive(container, data, name, graphScript, evalLivePy, extraModules = {}) {
  if (typeof container === "string") container = document.getElementById(container);
  container.classList.add("eval-live");
  container.innerHTML = "";

  const state = makeState(data, name, graphScript, evalLivePy);
  let engine = null;   // created at the end, once the DOM skeleton exists

  // Presentation and engine updates never request another calculation.
  function setState(mutator) {
    if (mutator(state) !== false) render();
  }

  function updateFilters(mutator) {
    if (mutator(state) === false) return;
    if (engine) engine.tick(state);
    else render();
  }

  const handlers = {
    onToggleCollapse: (n, kind) => setState((s) => toggleCollapsed(s, n, kind)),
    onSql: (n, val, kind) => updateFilters((s) => setSql(s, n, val, kind)),
    onColFilter: (n, col, val, kind) => updateFilters((s) => setColFilter(s, n, col, val, kind)),
    onHighlight: (n, mode, kind) => setState((s) => setHighlight(s, n, mode, kind)),
    onCheckbox: (n, col, checked, all, kind) => updateFilters((s) => toggleCheckbox(s, n, col, checked, all, kind)),
  };

  // --- persistent DOM skeleton (built once) -------------------------------
  if (name) {
    const h1 = document.createElement("h1");
    h1.className = "eval-live-title";
    h1.textContent = name + " — Eval Live";
    container.appendChild(h1);
  }

  // Graph section (only with a graph script). render() fills bar + display.
  let graphStatusEl = null, graphBar = null, graphDisplay = null;
  if (graphScript && evalLivePy) {
    const graphSection = document.createElement("div");
    graphSection.className = "graph-section";
    graphStatusEl = document.createElement("div");
    graphStatusEl.className = "graph-status";
    graphSection.appendChild(graphStatusEl);
    graphBar = document.createElement("div");
    graphBar.className = "graph-bar";
    graphSection.appendChild(graphBar);
    graphDisplay = document.createElement("div");
    graphDisplay.className = "graph-display";
    graphSection.appendChild(graphDisplay);
    container.appendChild(graphSection);
  }

  const clearBtn = document.createElement("button");
  clearBtn.className = "clear-filters-btn";
  clearBtn.textContent = "Clear all filters";
  clearBtn.addEventListener("click", () => updateFilters((s) => clearAllFilters(s)));
  container.appendChild(clearBtn);

  const computedContainer = document.createElement("div");
  computedContainer.className = "computed-container";
  container.appendChild(computedContainer);

  let rawHeader = null;
  const rawContainer = document.createElement("div");
  rawContainer.className = "raw-container";

  // Raw table views: data is fixed, so build once.
  const rawViews = [];
  for (const [tableName, rows] of Object.entries(data)) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const view = buildTableView(tableName, rows, "raw", true,
                                null, handlers);
    rawViews.push(view);
  }
  if (rawViews.length > 0) {
    rawHeader = document.createElement("h2");
    rawHeader.className = "raw-tables-header";
    rawHeader.textContent = "Raw Tables";
    container.appendChild(rawHeader);
    container.appendChild(rawContainer);
    for (const v of rawViews) rawContainer.appendChild(v.section);
  }

  const computedViews = new Map();
  function renderComputedTables() {
    const present = new Set();
    for (const [kind, tables] of [["computed", state.engine.computedTables], ["message", state.engine.messages]]) {
      for (const table of tables) {
        const key = tableKey(table.name, kind);
        const unfiltered = state.engine.computedUnfiltered.find(t => t.name === table.name);
        const options = kind === "computed" && unfiltered ? unfiltered.rows : table.rows;
        if (kind === "message" && !table.rows.length) continue;
        if (!options.length && !computedViews.has(key)) continue;
        present.add(key);
        ensureTableUi(state, table.name, kind);
        let view = computedViews.get(key);
        if (!view) {
          view = buildTableView(table.name, table.rows, kind, true, table.caption, handlers, options);
          computedViews.set(key, view);
          computedContainer.appendChild(view.section);
        }
        view.update(table.rows, options);
        view.sync(state);
      }
    }
    for (const [key, view] of computedViews) {
      if (!present.has(key)) { view.section.remove(); computedViews.delete(key); }
    }
  }

  // --- graph section reconcile -------------------------------------------
  function syncGraphs() {
    if (!graphStatusEl) return;
    const eng = state.engine;
    graphStatusEl.textContent =
      eng.status === "ready" ? (eng.graphs.length ? "" : "No graphs registered.")
                             : eng.statusText || "";

    graphBar.innerHTML = "";
    for (const g of eng.graphs) {
      const btn = document.createElement("button");
      btn.className = "graph-btn";
      btn.textContent = g.name;
      btn.addEventListener("click", () => setState((s) => setActiveGraph(s, g.name)));
      graphBar.appendChild(btn);
    }

    const active = resolveActiveGraph(state);
    const btns = graphBar.querySelectorAll(".graph-btn");
    btns.forEach((b) => b.classList.toggle("active", b.textContent === active));

    graphDisplay.innerHTML = "";
    const g = eng.graphs.find((x) => x.name === active);
    if (eng.status === "ready" && g && g.src) {
      const img = document.createElement("img");
      img.src = g.src;
      img.alt = g.name;
      graphDisplay.appendChild(img);
    }
  }

  // --- the render: reconcile everything from state ------------------------
  function render() {
    syncGraphs();
    renderComputedTables();
    for (const v of rawViews) v.sync(state);
  }

  render();
  if (graphScript && evalLivePy) {
    engine = createEngine(graphScript, evalLivePy, setState, extraModules);
    engine.tick(state);     // kick off Pyodide load + initial graphs/tables
  }

  return { getState: () => state, updateFilters, setState, render };
}
