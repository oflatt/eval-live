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
const REPORT_MESSAGE_TONES = new Set(["default", "positive", "negative", "warning", "error", "muted"]);
const REPORT_MESSAGE_LAYOUTS = new Set(["text", "caption"]);

/**
 * Render evaluation tables (and, when a graph script is supplied, Pyodide graphs
 * + computed tables) into a container.
 * @param {HTMLElement|string} container
 * @param {Object} data - { tableName: rows[] }
 * @param {string} [name] - project name shown in the heading
 * @param {string} [graphScript] - Python building an eval_live.Registry
 * @param {string} [evalLivePy] - source of eval_live.py
 * @param {Object.<string,string>} [extraModules] - {filename: source} extra
 *   Python modules written to the Pyodide filesystem, importable by graphScript
 */
function initEvalLive(container, data, name, graphScript, evalLivePy, extraModules = {}) {
  return initEvalLiveApp(container, data, name, graphScript, evalLivePy, extraModules, []);
}

/**
 * Render an ordered catalog of already-computed, independently filterable
 * tables. This entry point does not create the graph engine or load Pyodide.
 *
 * Each descriptor is `{id, name, rows, section?, caption?, columns?}`. `id` is
 * the unique, stable UI-state key; duplicate displayed `name` values are
 * allowed. Optional columns are ordered `{id, name, alignment?}` descriptors.
 * Descriptor, column, and row order are preserved.
 *
 * @param {HTMLElement|string} container
 * @param {Array} tables
 * @param {string} [name] - project name shown in the heading
 */
function initEvalLiveTables(container, tables, name) {
  const normalized = normalizePrecomputedTables(tables);
  const sections = [];
  for (const table of normalized) {
    const previous = sections[sections.length - 1];
    if (!previous || previous.title !== table.section) {
      sections.push({ id: `tables-${sections.length}`, title: table.section, blocks: [] });
    }
    sections[sections.length - 1].blocks.push(table);
  }
  return initEvalLiveApp(container, {}, name, null, null, {}, sections);
}

/**
 * Render an ordered, already-computed report catalog without Pyodide.
 *
 * Sections are `{id, title?, blocks}`. Blocks are either table descriptors with
 * `kind: "table"` and the same fields accepted by `initEvalLiveTables`, or inert
 * messages `{kind: "message", id, title?, text, tone?, layout?}`. Section and
 * block order are preserved, including sections that contain only messages.
 *
 * @param {HTMLElement|string} container
 * @param {Array} sections
 * @param {string} [name] - project name shown in the heading
 */
function initEvalLiveCatalog(container, sections, name) {
  return initEvalLiveApp(container, {}, name, null, null, {}, normalizePrecomputedCatalog(sections));
}

function normalizePrecomputedTables(tables) {
  if (!Array.isArray(tables)) throw new TypeError("tables must be an array");
  const ids = new Set();
  return tables.map((table, tableIndex) => {
    if (table === null || typeof table !== "object" || Array.isArray(table)) {
      throw new TypeError(`table ${tableIndex} must be an object`);
    }
    const id = ownValue(table, "id");
    const name = ownValue(table, "name");
    const rows = ownValue(table, "rows");
    const section = ownValue(table, "section");
    const caption = ownValue(table, "caption");
    const columns = ownValue(table, "columns");
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError(`table ${tableIndex} id must be a non-empty string`);
    }
    if (ids.has(id)) throw new TypeError(`duplicate table id: ${id}`);
    ids.add(id);
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(`table ${id} name must be a non-empty string`);
    }
    if (!Array.isArray(rows)) throw new TypeError(`table ${id} rows must be an array`);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        throw new TypeError(`table ${id} row ${rowIndex} must be an object`);
      }
    }
    if (section != null && typeof section !== "string") {
      throw new TypeError(`table ${id} section must be a string`);
    }
    if (caption != null && typeof caption !== "string") {
      throw new TypeError(`table ${id} caption must be a string`);
    }
    return {
      kind: "table",
      id,
      name,
      rows,
      section: section || null,
      caption: caption || null,
      columns: normalizePrecomputedColumns(columns, id),
    };
  });
}

function normalizePrecomputedCatalog(sections) {
  if (!Array.isArray(sections)) throw new TypeError("sections must be an array");
  const sectionIds = new Set();
  const blockIds = new Set();
  return sections.map((section, sectionIndex) => {
    if (section === null || typeof section !== "object" || Array.isArray(section)) {
      throw new TypeError(`section ${sectionIndex} must be an object`);
    }
    const id = ownValue(section, "id");
    const title = ownValue(section, "title");
    const blocks = ownValue(section, "blocks");
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError(`section ${sectionIndex} id must be a non-empty string`);
    }
    if (sectionIds.has(id)) throw new TypeError(`duplicate section id: ${id}`);
    sectionIds.add(id);
    if (title != null && typeof title !== "string") {
      throw new TypeError(`section ${id} title must be a string`);
    }
    if (!Array.isArray(blocks)) throw new TypeError(`section ${id} blocks must be an array`);
    return {
      id,
      title: title || null,
      blocks: blocks.map((block, blockIndex) => {
        if (block === null || typeof block !== "object" || Array.isArray(block)) {
          throw new TypeError(`section ${id} block ${blockIndex} must be an object`);
        }
        const blockId = ownValue(block, "id");
        const kind = ownValue(block, "kind");
        if (typeof blockId !== "string" || blockId.length === 0) {
          throw new TypeError(`section ${id} block ${blockIndex} id must be a non-empty string`);
        }
        if (blockIds.has(blockId)) throw new TypeError(`duplicate block id: ${blockId}`);
        blockIds.add(blockId);
        if (kind === "table") {
          const table = normalizePrecomputedTables([block])[0];
          table.section = null;
          return table;
        }
        if (kind !== "message") {
          throw new TypeError(`block ${blockId} kind must be table or message`);
        }
        const messageTitle = ownValue(block, "title");
        const text = ownValue(block, "text");
        const tone = ownValue(block, "tone");
        const layout = ownValue(block, "layout");
        if (messageTitle != null && typeof messageTitle !== "string") {
          throw new TypeError(`message ${blockId} title must be a string`);
        }
        if (typeof text !== "string") throw new TypeError(`message ${blockId} text must be a string`);
        if (tone != null && !REPORT_MESSAGE_TONES.has(tone)) {
          throw new TypeError(`message ${blockId} tone is not supported`);
        }
        if (layout != null && !REPORT_MESSAGE_LAYOUTS.has(layout)) {
          throw new TypeError(`message ${blockId} layout is not supported`);
        }
        return {
          kind: "message",
          id: blockId,
          title: messageTitle || null,
          text,
          tone: tone || "default",
          layout: layout || "text",
        };
      }),
    };
  });
}

function normalizePrecomputedColumns(columns, tableId) {
  if (columns == null) return null;
  if (!Array.isArray(columns)) throw new TypeError(`table ${tableId} columns must be an array`);
  const ids = new Set();
  return columns.map((column, columnIndex) => {
    if (column === null || typeof column !== "object" || Array.isArray(column)) {
      throw new TypeError(`table ${tableId} column ${columnIndex} must be an object`);
    }
    const id = ownValue(column, "id");
    const name = ownValue(column, "name");
    const alignment = ownValue(column, "alignment");
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError(`table ${tableId} column ${columnIndex} id must be a non-empty string`);
    }
    if (ids.has(id)) throw new TypeError(`table ${tableId} has duplicate column id: ${id}`);
    ids.add(id);
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(`table ${tableId} column ${id} name must be a non-empty string`);
    }
    if (alignment != null && !["left", "center", "right"].includes(alignment)) {
      throw new TypeError(`table ${tableId} column ${id} alignment must be left, center, or right`);
    }
    return { id, name, alignment: alignment || null };
  });
}

function initEvalLiveApp(container, data, name, graphScript, evalLivePy, extraModules, precomputedSections) {
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

  // Precomputed report blocks are presentation-ready data. Table ids, rather
  // than their potentially duplicated display names, own UI state; messages
  // remain inert and retain their exact position among tables.
  const precomputedViews = [];
  if (precomputedSections.length > 0) {
    const precomputedContainer = document.createElement("div");
    precomputedContainer.className = "precomputed-container";
    for (const reportSection of precomputedSections) {
      const section = document.createElement("section");
      section.className = "precomputed-report-section";
      section.dataset.sectionId = reportSection.id;
      if (reportSection.title) {
        const heading = document.createElement("h2");
        heading.className = "report-section-heading";
        heading.textContent = reportSection.title;
        section.appendChild(heading);
      }
      for (const block of reportSection.blocks) {
        if (block.kind === "message") {
          const message = document.createElement("aside");
          message.className = `report-message tone-${block.tone} layout-${block.layout}`;
          if (block.title) {
            const title = document.createElement("strong");
            title.className = "report-message-title";
            title.textContent = block.title + " — ";
            message.appendChild(title);
          }
          const text = document.createElement("span");
          text.textContent = block.text;
          message.appendChild(text);
          section.appendChild(message);
          continue;
        }
        // Precomputed report columns commonly mix units (for example a ratio,
        // percent change, and file count). Do not imply that their smallest raw
        // number is inherently best; users can opt into highlighting per table.
        ensureTableUi(state, block.id, "precomputed").highlight = "none";
        const view = buildTableView(
          block.name, block.rows, "precomputed", true, block.caption,
          handlers, block.rows, block.id, block.columns);
        precomputedViews.push(view);
        section.appendChild(view.section);
      }
      precomputedContainer.appendChild(section);
    }
    container.appendChild(precomputedContainer);
  }

  let rawHeader = null;
  const rawContainer = document.createElement("div");
  rawContainer.className = "raw-container";

  // Raw table views: data is fixed, so build once.
  const rawViews = [];
  for (const [tableName, rows] of Object.entries(data)) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const view = buildTableView(tableName, rows, "raw", true,
                                ownValue(TABLE_DESCRIPTIONS, tableName), handlers);
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
                                  t.caption, handlers, optionRows);
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
    for (const v of precomputedViews) v.sync(state);
    for (const v of rawViews) v.sync(state);
  }

  render();
  if (graphScript && evalLivePy) {
    engine = createEngine(graphScript, evalLivePy, setState, extraModules);
    engine.tick(state);     // kick off Pyodide load + initial graphs/tables
  }

  return { getState: () => state, setState, render };
}
