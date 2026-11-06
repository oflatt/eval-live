/* Calculate browser reports; DOM updates belong to eval-live.js.
   Each input change requests a complete calculation. Tables, graphs, and
   diagnostics are published together for the latest requested filters.
   Loaded as a plain script after state.js; the page supplies loadPyodide. */

/**
 * Create an engine that evaluates graphScript's eval_live.registry in Pyodide.
 *
 * @param {string} graphScript Python that registers the report callbacks
 * @param {string} evalLivePy source of the eval_live Python module
 * @param {function} setState applies a state mutator and redraws the view;
 *   it must not call tick, or publishing a result would start another calculation
 * @param {Object.<string,string>} [extraModules] Python filenames mapped to source
 * @returns {{tick: function}} Call tick(state) initially and after filter changes.
 *   Keep state.data unchanged for the viewer's lifetime. Presentation-only changes
 *   such as selecting a graph do not require a calculation.
 *
 * Display results only while engine.status is "ready". An unhandled failure
 * sets status to "error" with statusText describing it. An obsolete calculation's
 * results and errors are discarded; its Python execution is allowed to finish.
 */
function createEngine(graphScript, evalLivePy, setState, extraModules = {}) {
  let pyodide = null;
  let loadPromise = null;
  let running = false;
  let pending = null;
  let revision = 0;
  let debounceTimer = null;

  function setStatus(status, text) {
    setState((s) => { s.engine.status = status; s.engine.statusText = text || ""; });
  }

  async function ensurePyodide() {
    if (pyodide) return pyodide;
    if (!loadPromise) {
      loadPromise = (async () => {
        setStatus("loading", "Loading Pyodide...");
        const py = await loadPyodide();
        setStatus("loading", "Installing matplotlib...");
        await py.loadPackage("matplotlib");
        // Load any other packages imported by the graph script or the caller's
        // extra modules (e.g. scipy, pandas), as matplotlib already is. Extra
        // modules are scanned too since the graph script may only `import` them
        // while the packages they need live inside those modules.
        setStatus("loading", "Loading script packages...");
        for (const src of [graphScript, ...Object.values(extraModules)]) {
          await py.loadPackagesFromImports(src);
        }
        py.FS.writeFile("/home/pyodide/eval_live.py", evalLivePy);
        // Caller-provided Python modules, importable by the graph script.
        for (const [filename, source] of Object.entries(extraModules)) {
          py.FS.writeFile("/home/pyodide/" + filename, source);
        }
        pyodide = py;
        return py;
      })();
    }
    return loadPromise;
  }

  function setData(filteredData) {
    const value = pyodide.toPy(filteredData);
    try { pyodide.globals.set("__eval_live_data__", value); }
    finally { if (value.destroy) value.destroy(); }
  }

  // Computed presentation cells may contain nested text/style dictionaries.
  // Convert those too, so the DOM receives ordinary objects at every depth.
  function plainValue(value) {
    if (value instanceof Map) {
      return Object.fromEntries(Array.from(value, ([key, item]) => [key, plainValue(item)]));
    }
    browserNumbers(value);
    return Array.isArray(value) ? value.map(plainValue) : value;
  }

  async function runGraphs(filteredData) {
    setData(filteredData);
    const proxy = await pyodide.runPythonAsync(
      "import eval_live; eval_live.registry.run_graphs(__eval_live_data__)");
    // Explicitly preserve the Map representation consumed below, independent
    // of the Pyodide version's default conversion for string-keyed dicts.
    const raw = proxy.toJs({ create_pyproxies: false, dict_converter: (entries) => new Map(entries) });
    proxy.destroy();
    return raw.map((g) => ({ name: g.get("name"), src: g.get("src") }));
  }

  async function runTables(filteredData, messages = false) {
    setData(filteredData);
    const proxy = await pyodide.runPythonAsync(
      messages ? "import eval_live; eval_live.registry.run_messages()" :
        "import eval_live; eval_live.registry.run_tables(__eval_live_data__)");
    const raw = proxy.toJs({ create_pyproxies: false, dict_converter: (entries) => new Map(entries) });
    proxy.destroy();
    return raw.map((t) => ({
      name: t.get("name"),
      rows: t.get("rows").map(plainValue),
      hasInteractiveFilter: t.get("has_interactive_filter"),
      caption: t.get("caption"),
    }));
  }

  async function runNarrowing(tableFilters, data) {
    setData(data);
    const filters = pyodide.toPy(tableFilters);
    try { pyodide.globals.set("__eval_live_table_filters__", filters); }
    finally { if (filters.destroy) filters.destroy(); }
    const proxy = await pyodide.runPythonAsync(
      "import eval_live; eval_live.registry.apply_table_filters(__eval_live_table_filters__, __eval_live_data__)");
    const result = proxy.toJs({ create_pyproxies: false, dict_converter: (entries) => new Map(entries) });
    proxy.destroy();
    const out = {};
    for (const [k, v] of result.entries()) {
      out[k] = Array.isArray(v)
        ? v.map(plainValue)
        : v;
    }
    return out;
  }

  async function calculate(snapshot) {
    await ensurePyodide();
    pyodide.runPython("import eval_live; eval_live.registry = None");
    await pyodide.runPythonAsync(graphScript);
    const raw = rawFilteredData(snapshot);
    // Select groups from tables before input narrowing. Feeding displayed tables
    // back into this selection would make the filters depend on their own results.
    snapshot.engine.computedUnfiltered = await runTables(raw);
    const filters = computedFilterInputs(snapshot);
    snapshot.engine.narrowing = filters.length ? await runNarrowing(filters, raw) : null;
    const data = effectiveRawData(snapshot);
    snapshot.engine.computedTables = filters.length
      ? await runTables(data) : snapshot.engine.computedUnfiltered;
    snapshot.engine.graphs = await runGraphs(data);
    // Read diagnostics after the callbacks have seen the final filtered data.
    const messages = await runTables(data, true);
    return {...snapshot.engine, messages, status: "ready", statusText: ""};
  }

  async function drain() {
    // Pyodide has shared globals: finish one calculation before starting another.
    // tick replaces pending work, so only the newest queued selection is evaluated.
    if (running) return;
    running = true;
    try {
      while (pending) {
        const job = pending;
        pending = null;
        try {
          const result = await calculate(job.snapshot);
          if (job.revision === revision) setState((s) => { s.engine = result; });
        } catch (error) {
          if (job.revision === revision) {
            setStatus("error", String(error && error.message ? error.message : error));
          }
        }
      }
    } finally {
      running = false;
    }
  }

  // Copy the filters before any await; an in-flight calculation must not observe
  // later edits. The revision also prevents it from publishing after a newer tick.
  function tick(state) {
    pending = {revision: ++revision, snapshot: {
      data: state.data,
      ui: JSON.parse(JSON.stringify(state.ui)),
      engine: {},
    }};
    setState((s) => {
      s.engine.status = "loading";
      s.engine.statusText = "Updating report...";
      s.engine.narrowing = null;
    });
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(drain, 300);
  }

  return { tick };
}
