/* Exercise complete recomputation and the asynchronous Pyodide boundary. */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

function setup(data, hooks = {}) {
  const globals = new Map();
  const counts = {created: 0, destroyed: 0, tables: 0, graphs: 0, filters: 0, scripts: 0};
  function proxy(value) {
    counts.created++;
    return {
      toJs(options) {
        assert.equal(options.create_pyproxies, false);
        function convert(item) {
          if (Array.isArray(item)) return item.map(convert);
          if (item !== null && typeof item === "object") {
            return options.dict_converter(Object.entries(item).map(([key, val]) => [key, convert(val)]));
          }
          return item;
        }
        return convert(value);
      },
      destroy() { counts.destroyed++; },
    };
  }
  const py = {
    globals, FS: {writeFile() {}}, toPy(value) {return value;},
    async loadPackage() {}, async loadPackagesFromImports() {}, runPython() {},
    async runPythonAsync(source) {
      const input = globals.get("__eval_live_data__");
      if (source.includes(".run_messages(")) return proxy(hooks.messages ? hooks.messages() : []);
      if (source.includes(".run_tables(")) {
        counts.tables++;
        return proxy(hooks.tables ? await hooks.tables(input) : [{
          name: "Summary", rows: input.samples.map(row => ({...row, styled: {text: row.id, style: {bold: true}}})),
          has_interactive_filter: true, caption: "Sample IDs",
        }]);
      }
      if (source.includes(".run_graphs(")) {
        counts.graphs++;
        return proxy([{name: "Samples", src: JSON.stringify(input.samples)}]);
      }
      if (source.includes(".apply_table_filters(")) {
        counts.filters++;
        const filters = globals.get("__eval_live_table_filters__");
        if (hooks.narrow) return proxy(await hooks.narrow(input, filters));
        const ids = new Set(filters[0].filtered_rows.map(row => row.id));
        return proxy({...input, samples: input.samples.filter(row => ids.has(row.id))});
      }
      counts.scripts++;
    },
  };
  const ctx = {console, setTimeout, clearTimeout, loadPyodide: async () => py};
  vm.createContext(ctx);
  for (const file of ["sql-filter.js", "state.js", "graph-engine.js"]) {
    vm.runInContext(readFileSync(new URL("../eval_live/" + file, import.meta.url), "utf8"), ctx);
  }
  const state = ctx.makeState(data, "Demo", "script", "library");
  const published = [];
  const engine = ctx.createEngine("script", "library", mutate => {
    mutate(state);
    if (state.engine.status === "ready") published.push(state.engine);
  });
  return {ctx, state, engine, counts, published};
}

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), "engine did not settle");
}
async function ready(state) {
  await until(() => state.engine.status !== "loading");
  assert.equal(state.engine.status, "ready", state.engine.statusText);
}
const rows = [{id: "one", value: 1}, {id: "two", value: 2}];

{
  const {ctx, state, engine, counts} = setup({samples: rows});
  engine.tick(state);
  await ready(state);
  assert.equal(state.engine.computedTables[0].caption, "Sample IDs");
  assert.equal(state.engine.computedTables[0].rows[0].styled.style.bold, true);
  assert.equal(JSON.parse(state.engine.graphs[0].src).length, 2);
  engine.tick(state);
  await ready(state);
  assert.equal(counts.graphs, 2, "identical inputs still redraw figures");
  assert.equal(counts.tables, 2);
  assert.equal(counts.scripts, 2);
  ctx.setSql(state, "Summary", "one", "computed");
  engine.tick(state);
  await ready(state);
  assert.equal(state.engine.computedTables[0].rows.length, 1);
  assert.equal(JSON.parse(state.engine.graphs[0].src)[0].id, "one");
  assert.equal(state.data.samples.length, 2);
  assert.equal(counts.created, counts.destroyed);
  console.log("  ok  every calculation reruns callbacks, preserves styles, and releases proxies");
}

{
  const seen = [];
  const hooks = {
    tables: async () => [{name: "Groups", rows: [{group: "G"}], has_interactive_filter: true}],
    narrow: async data => {
      seen.push(data.samples.map(row => row.id));
      assert.ok("empty" in data);
      return {...data, samples: data.samples.slice(0, 1).map(row => ({value: row.value, id: row.id}))};
    },
  };
  const {ctx, state, engine} = setup({samples: rows, empty: []}, hooks);
  ctx.setSql(state, "Groups", "G", "computed");
  engine.tick(state);
  await ready(state);
  ctx.setColFilter(state, "samples", "id", "two");
  engine.tick(state);
  await ready(state);
  assert.equal(JSON.stringify(seen), '[["one","two"],["two"]]');
  assert.deepEqual(JSON.parse(state.engine.graphs[0].src), [rows[1]]);
  console.log("  ok  narrowing receives current raw-filtered inputs and ignores dictionary order");
}

for (const failObsolete of [false, true]) {
  let release, started = false, calls = 0;
  const gate = new Promise(resolve => {release = resolve;});
  const hooks = {tables: async data => {
    const count = data.samples.length;
    if (++calls === 1) {
      started = true;
      await gate;
      if (failObsolete) throw new Error("obsolete failure");
    }
    return [{name: "Count", rows: [{count}], has_interactive_filter: false}];
  }};
  const {ctx, state, engine, published} = setup({samples: rows}, hooks);
  engine.tick(state);
  await until(() => started);
  ctx.setColFilter(state, "samples", "id", "two");
  engine.tick(state);
  release();
  await ready(state);
  assert.equal(published.length, 1, "obsolete results must never be published");
  assert.equal(state.engine.computedTables[0].rows[0].count, 1);
  assert.equal(JSON.parse(state.engine.graphs[0].src).length, 1);
}
console.log("  ok  mid-flight changes discard both obsolete results and obsolete errors");

{
  const hooks = {tables: async () => {throw new Error("calculation failed");}};
  const {state, engine} = setup({samples: rows}, hooks);
  engine.tick(state);
  await until(() => state.engine.status === "error");
  hooks.tables = async () => [{name: "Unsafe", rows: [{value: 9007199254740993n}]}];
  engine.tick(state);
  await until(() => state.engine.status === "error");
  assert.match(state.engine.statusText, /browser's exact range/);
  delete hooks.tables;
  engine.tick(state);
  await ready(state);
  assert.equal(state.engine.computedTables[0].rows.length, 2);
  console.log("  ok  unsafe computed integers fail visibly and failed calculations can be retried");
}

{
  let tables = 0;
  const hooks = {
    tables: async () => {tables++; return [{name: "Groups", rows: [{group: "G"}], has_interactive_filter: true}];},
    narrow: async data => ({...data, samples: data.samples.slice(1)}),
    messages: () => [
      {name: "Warnings", rows: tables === 1 ? [{message: "excluded input"}] : []},
      {name: "Errors", rows: tables === 1 ? [{message: "excluded failed input"}] : []},
    ],
  };
  const {ctx, state, engine} = setup({samples: rows}, hooks);
  ctx.setSql(state, "Groups", "G", "computed");
  engine.tick(state);
  await ready(state);
  assert.equal(state.engine.messages[0].rows.length, 0, "warnings describe effective inputs");
  assert.equal(state.engine.messages[1].rows.length, 0, "errors also describe effective inputs");
  console.log("  ok  warnings and errors describe the final narrowed data");
}
