/* Part of eval-live -- the entry point and owner of the single state object.
   Architecture (see state.js for the data shape):

     event -> setState(reducer) -> render(state) [+ engine.tick(state)]

   There is ONE `state`. Reducers mutate it; setState() re-renders and nudges the
   Pyodide engine. render(state) reconciles a persistent DOM skeleton to the
   current state -- it builds structure once (graph section, table views, clear
   button) and is otherwise idempotent: table views toggle row visibility rather
   than rebuilding, so render is cheap to call on every keystroke. The expensive,
   async work (graphs, computed-table rows, narrowing) lives behind the engine's
   memoized effects, which write their results back via setState.

   Loaded as a plain <script>; depends on state.js, table-view.js, graph-engine.js. */

// Clarifying subtitles for known raw result tables.
const TABLE_DESCRIPTIONS = {
  warnings: "Expected, non-bug failures: timeouts and cells that use a feature "
    + "the backend/encoding does not support (push/pop, proofs-incompatible "
    + "commands). Kept out of “errors” on purpose.",
  errors: "Real, unexpected failures (likely bugs). Expected non-bug failures "
    + "live in the “warnings” table instead.",
  skipped: "Files excluded up front (not benchmarked) and why — e.g. "
    + "unsupported by the term encoding, or no bridge-normal reference.",
};

/**
 * Render evaluation tables (and, when a graph script is supplied, Pyodide graphs
 * + computed tables) into a container.
 * @param {HTMLElement|string} container
 * @param {Object} data - { tableName: rows[] }
 * @param {string} [name] - project name shown in the heading
 * @param {string} [graphScript] - Python building an eval_live.Registry
 * @param {string} [evalLivePy] - source of eval_live.py
 */
function initEvalLive(container, data, name, graphScript, evalLivePy) {
  if (typeof container === "string") container = document.getElementById(container);
  container.classList.add("eval-live");
  container.innerHTML = "";

  const state = makeState(data, name, graphScript, evalLivePy);
  let engine = null;   // created at the end, once the DOM skeleton exists

  // --- reducer dispatch ---------------------------------------------------
  function setState(mutator) {
    const changed = mutator(state);
    if (changed === false) return;          // reducer reported a no-op
    render();
    if (engine) engine.tick(state);
  }

  const handlers = {
    onToggleCollapse: (n) => setState((s) => toggleCollapsed(s, n)),
    onSql: (n, val) => setState((s) => setSql(s, n, val)),
    onColFilter: (n, col, val) => setState((s) => setColFilter(s, n, col, val)),
    onHighlight: (n, mode) => setState((s) => setHighlight(s, n, mode)),
    onCheckbox: (n, col, checked, all) => setState((s) => toggleCheckbox(s, n, col, checked, all)),
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
  let lastGraphsRef = null;
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
  clearBtn.addEventListener("click", () => setState((s) => clearAllFilters(s)));
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
                                TABLE_DESCRIPTIONS[tableName], handlers);
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

  // Computed table views: rebuilt whenever the engine replaces computedTables
  // (detected by array-reference identity, which the engine bumps only on a real
  // recompute). UI state lives in state.ui, so it survives the rebuild.
  let computedViews = [];
  let lastComputedRef = null;
  let lastUnfilteredRef = null;
  function rebuildComputedViews() {
    computedContainer.innerHTML = "";
    computedViews = [];
    for (const t of state.engine.computedTables) {
      if (!t.rows || t.rows.length === 0) continue;
      ensureTableUi(state, t.name, "computed");     // persist ui across rebuilds
      // Checkbox options come from the UNFILTERED version of this table, so
      // unchecking a value doesn't make it disappear as the display narrows.
      const unfiltered = state.engine.computedUnfiltered.find((u) => u.name === t.name);
      const optionRows = unfiltered ? unfiltered.rows : t.rows;
      const view = buildTableView(t.name, t.rows, "computed", t.hasFilterSource,
                                  undefined, handlers, optionRows);
      computedViews.push(view);
      computedContainer.appendChild(view.section);
    }
  }

  // --- graph section reconcile -------------------------------------------
  function syncGraphs() {
    if (!graphStatusEl) return;
    const eng = state.engine;
    graphStatusEl.textContent =
      eng.status === "ready" ? (eng.graphs.length ? "" : "No graphs registered.")
                             : eng.statusText || "";

    if (eng.graphs !== lastGraphsRef) {
      lastGraphsRef = eng.graphs;
      graphBar.innerHTML = "";
      for (const g of eng.graphs) {
        const btn = document.createElement("button");
        btn.className = "graph-btn";
        btn.textContent = g.name;
        btn.addEventListener("click", () => setState((s) => setActiveGraph(s, g.name)));
        graphBar.appendChild(btn);
      }
    }

    const active = resolveActiveGraph(state);
    const btns = graphBar.querySelectorAll(".graph-btn");
    btns.forEach((b) => b.classList.toggle("active", b.textContent === active));

    graphDisplay.innerHTML = "";
    const g = eng.graphs.find((x) => x.name === active);
    if (g && g.src) {
      const img = document.createElement("img");
      img.src = g.src;
      img.alt = g.name;
      graphDisplay.appendChild(img);
    }
  }

  // --- the render: reconcile everything from state ------------------------
  function render() {
    syncGraphs();
    // Rebuild computed views when the displayed rows OR the unfiltered rows
    // (which feed the dropdown options) change.
    if (state.engine.computedTables !== lastComputedRef ||
        state.engine.computedUnfiltered !== lastUnfilteredRef) {
      lastComputedRef = state.engine.computedTables;
      lastUnfilteredRef = state.engine.computedUnfiltered;
      rebuildComputedViews();
    }
    for (const v of computedViews) v.sync(state);
    for (const v of rawViews) v.sync(state);
  }

  render();
  if (graphScript && evalLivePy) {
    engine = createEngine(graphScript, evalLivePy, setState);
    engine.tick(state);     // kick off Pyodide load + initial graphs/tables
  }

  return { getState: () => state, setState, render };
}
