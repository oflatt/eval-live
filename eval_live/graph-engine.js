/* Part of eval-live -- the Pyodide engine, as a set of MEMOIZED ASYNC EFFECTS.
   It owns no DOM: the graph bar and graph image are rendered by initEvalLive's
   render() from state.engine.{graphs,activeGraph}. This module just turns
   filtered data into engine outputs and writes them back through setState.

   Two independent effects, each keyed on its inputs so Pyodide only re-runs when
   something actually changed:
     1. graphs + computed-table rows  <- rawFilteredData(state)   (raw filters)
     2. computed->raw narrowing        <- computedFilterInputs(state) (computed filters)
   Effect 1's input ignores the narrowing (see state.js), so the two never form a
   recompute cycle. A debounce coalesces bursts of keystrokes; a running-lock
   serializes Pyodide calls (it is single-threaded) and re-runs once if more work
   arrived mid-flight.

   `loadPyodide` is expected as a global, supplied by the embedding page (the
   same assumption the previous engine made). Loaded as a plain <script>;
   depends on state.js. */

function createEngine(graphScript, evalLivePy, setState, extraModules = {}) {
  let pyodide = null;
  let loadPromise = null;
  const cache = { rawKey: null, narrowKey: null, displayKey: null, graphKey: null };
  let running = false;
  let rerunRequested = false;
  let debounceTimer = null;
  let latestState = null;

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
        setStatus("loading", "Running graph script...");
        await py.runPythonAsync(graphScript);
        pyodide = py;
        setStatus("ready", "");
        return py;
      })();
    }
    return loadPromise;
  }

  function setData(filteredData) {
    pyodide.globals.set("__eval_live_data__", pyodide.toPy(plainInteropValue(filteredData)));
  }

  async function runGraphs(filteredData) {
    setData(filteredData);
    const proxy = await pyodide.runPythonAsync(
      "import eval_live; eval_live.registry.run_graphs(__eval_live_data__)");
    const raw = proxy.toJs({ create_proxies: false });
    proxy.destroy();
    return raw.map((g) => ({ name: g.get("name"), src: g.get("src") }));
  }

  async function runTables(filteredData) {
    setData(filteredData);
    const proxy = await pyodide.runPythonAsync(
      "import eval_live; eval_live.registry.run_tables(__eval_live_data__)");
    const raw = proxy.toJs({ create_proxies: false });
    proxy.destroy();
    return raw.map((t) => ({
      name: t.get("name"),
      rows: t.get("rows").map((r) => Object.fromEntries(r.entries())),
      hasFilterSource: t.get("has_filter_source"),
      caption: t.get("caption"),
    }));
  }

  async function runNarrowing(tableFilters, data) {
    pyodide.globals.set("__eval_live_data__", pyodide.toPy(plainInteropValue(data)));
    pyodide.globals.set("__eval_live_table_filters__", pyodide.toPy(plainInteropValue(tableFilters)));
    const proxy = await pyodide.runPythonAsync(
      "import eval_live; eval_live.registry.apply_table_filters(__eval_live_table_filters__, __eval_live_data__)");
    const result = proxy.toJs({ create_proxies: false });
    proxy.destroy();
    const out = dictionary();
    for (const [k, v] of result.entries()) {
      out[k] = Array.isArray(v)
        ? v.map((r) => (r instanceof Map ? Object.fromEntries(r.entries()) : r))
        : v;
    }
    return out;
  }

  async function runEffects() {
    await ensurePyodide();
    // Rebuild the registry at most once per pass, and only if something runs.
    let registryFresh = false;
    async function freshRegistry() {
      if (registryFresh) return;
      pyodide.runPython("import eval_live; eval_live.registry = None");
      await pyodide.runPythonAsync(graphScript);
      registryFresh = true;
    }

    // Acyclic DAG, run in order. Each setState mutates the shared state in
    // place, so a later stage sees an earlier stage's output via latestState.

    // A1: UNFILTERED computed tables, from raw-filtered data only. These are the
    //     source for checkbox options and for the narrowing selection (B). They
    //     never depend on the narrowing, which is what keeps the graph acyclic.
    const rawFd = rawFilteredData(latestState);
    const rawKey = stableKey(rawFd);
    if (rawKey !== cache.rawKey) {
      cache.rawKey = rawKey;
      await freshRegistry();
      const computedUnfiltered = await runTables(rawFd);
      setState((s) => { s.engine.computedUnfiltered = computedUnfiltered; });
    }

    // B: computed->raw narrowing, from the user's selection applied to the
    //    UNFILTERED tables (computedFilterInputs reads computedUnfiltered).
    const cf = computedFilterInputs(latestState);
    const narrowKey = stableKey(cf);
    if (narrowKey !== cache.narrowKey) {
      cache.narrowKey = narrowKey;
      if (cf.length === 0) {
        setState((s) => { s.engine.narrowing = null; });
      } else {
        await freshRegistry();
        const narrowed = await runNarrowing(cf, latestState.data);
        setState((s) => { s.engine.narrowing = narrowed; });
      }
    }

    // A2: DISPLAYED computed tables, from the effective (narrowed) data, so a
    //     filter on one computed table narrows them all. With nothing narrowed,
    //     reuse the unfiltered tables -- no extra Pyodide call.
    const eff = effectiveRawData(latestState);
    const displayKey = stableKey(eff);
    if (displayKey !== cache.displayKey) {
      cache.displayKey = displayKey;
      if (!latestState.engine.narrowing) {
        setState((s) => { s.engine.computedTables = s.engine.computedUnfiltered; });
      } else {
        await freshRegistry();
        const displayed = await runTables(eff);
        setState((s) => { s.engine.computedTables = displayed; });
      }
    }

    // C: graphs, from the effective data (reflect both raw and computed filters).
    const graphKey = stableKey(eff);
    if (graphKey !== cache.graphKey) {
      cache.graphKey = graphKey;
      await freshRegistry();
      const graphs = await runGraphs(eff);
      setState((s) => { s.engine.graphs = graphs; });
    }
  }

  async function drain() {
    if (running) { rerunRequested = true; return; }
    running = true;
    try {
      do {
        rerunRequested = false;
        await runEffects();
      } while (rerunRequested);
    } catch (e) {
      setStatus("error", String(e && e.message ? e.message : e));
      // eslint-disable-next-line no-console
      console.error("eval-live engine error:", e);
    } finally {
      running = false;
    }
  }

  // Called by the owner after every render. Debounced so a burst of keystrokes
  // collapses into one Pyodide pass; memo keys then skip work that did not change.
  function tick(state) {
    latestState = state;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { drain(); }, 300);
  }

  return { tick };
}

// Browser state uses null-prototype dictionaries so caller-owned table names
// such as `__proto__` remain ordinary keys. Rebuild ordinary objects only at
// the legacy Pyodide boundary, whose conversion support varies by release.
// Object.fromEntries creates own properties without invoking `__proto__`'s
// legacy setter.
function plainInteropValue(value) {
  if (Array.isArray(value)) return value.map(plainInteropValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).map((key) => [key, plainInteropValue(value[key])]),
    );
  }
  return value;
}
