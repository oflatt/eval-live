/* End-to-end smoke test of the DOM layer with a tiny hand-rolled DOM shim (no
   jsdom / npm). It drives the public static table APIs (no graph script or
   Pyodide) and asserts the state<->DOM wiring: filtering
   hides rows, the heading collapses the section, a checkbox rewrites the SQL box
   and filters rows, and "Clear all filters" resets everything.

   The shim implements only what these modules touch. Run: `node test/dom.test.mjs`. */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

// ---- minimal DOM shim -----------------------------------------------------
class El {
  constructor(tag) {
    this.tagName = (tag || "div").toUpperCase();
    this._children = [];
    this._classes = new Set();
    this._text = "";
    this._listeners = {};
    this.dataset = {};
    this.style = {};
    this.value = "";
    this.checked = false;
  }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(" "); }
  get classList() {
    const c = this._classes;
    return {
      add: (n) => c.add(n),
      remove: (n) => c.delete(n),
      contains: (n) => c.has(n),
      toggle: (n, force) => {
        const want = force === undefined ? !c.has(n) : !!force;
        if (want) c.add(n); else c.delete(n);
        return want;
      },
    };
  }
  set textContent(v) { this._children = []; this._text = String(v); }
  get textContent() {
    return (this._text || "") + this._children.map((c) => c.textContent).join("");
  }
  set innerHTML(v) { this._children = []; this._text = ""; }
  get innerHTML() { return ""; }
  appendChild(c) { this._children.push(c); return c; }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  dispatch(type) { for (const fn of this._listeners[type] || []) fn({ target: this }); }
  click() { this.dispatch("click"); }
  *walk() { yield this; for (const c of this._children) yield* c.walk(); }
  find(cls) { for (const n of this.walk()) if (n._classes.has(cls)) return n; return null; }
  findAll(cls) { return [...this.walk()].filter((n) => n._classes.has(cls)); }
  findTag(tag) { const t = tag.toUpperCase(); for (const n of this.walk()) if (n.tagName === t) return n; return null; }
}
const document = {
  activeElement: null,
  createElement: (t) => new El(t),
  getElementById: () => new El("div"),
};

// ---- load the browser modules into a shared context ----------------------
const dir = new URL("../eval_live/", import.meta.url);
const ctx = {
  document, console, module: { exports: {} },
  setTimeout, clearTimeout,
};
ctx.window = ctx;
ctx.self = ctx;
vm.createContext(ctx);
for (const f of [
  "vendor/alasql.min.js", "sql-filter.js", "state.js", "table-view.js", "graph-engine.js", "eval-live.js",
]) {
  vm.runInContext(readFileSync(new URL(f, dir), "utf8"), ctx, { filename: f });
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok  " + name); }

const DATA = {
  errors: [
    { backend: "feldera", mode: "proofs", file: "a.egg" },
    { backend: "feldera", mode: "naive", file: "b.egg" },
    { backend: "flowlog", mode: "proofs", file: "c.egg" },
  ],
};
function fresh() {
  const root = new El("div");
  const api = ctx.initEvalLive(root, DATA, "Test");
  const section = root.find("table-section");
  return { root, api, section };
}
function visibleRowCount(section) {
  return section.findTag("tbody")._children.filter((tr) => tr.style.display !== "none").length;
}

test("builds a section per non-empty table with full row count", () => {
  const { root, section } = fresh();
  assert.equal(root.findAll("table-section").length, 1);
  assert.equal(section.find("row-count").textContent, "(3 rows)");
  assert.equal(visibleRowCount(section), 3);
});

test("typing in the SQL box filters rows and updates the count", () => {
  const { api, section } = fresh();
  const sql = section.find("sql-filter-input");
  sql.value = "flowlog";          // bare word -> substring fallback (no AlaSQL here)
  sql.dispatch("input");
  assert.equal(api.getState().ui.tables.errors.sql, "flowlog");
  assert.equal(visibleRowCount(section), 1);
  assert.equal(section.find("row-count").textContent, "(1/3 rows)");
});

test("clicking the heading toggles the collapsed class", () => {
  const { section } = fresh();
  const heading = section.find("table-heading");
  assert.equal(section.classList.contains("collapsed"), false);
  heading.click();
  assert.equal(section.classList.contains("collapsed"), true);
  heading.click();
  assert.equal(section.classList.contains("collapsed"), false);
});

test("unchecking a checkbox rewrites the SQL box (round-trips through state)", () => {
  // Wiring only: the actual row filtering for a generated `backend = '...'`
  // clause needs AlaSQL (absent here -> substring fallback), so it is exercised
  // in the browser. Here we prove checkbox -> state.sql -> input -> checkbox.
  const { api, section } = fresh();
  // cols are backend(2), mode(2), file(3); first checkbox is backend's first value.
  const box = section.findAll("checkbox-item")[0]._children[0]; // the <input>
  assert.equal(box.checked, true);
  box.checked = false;
  box.dispatch("change");
  const sql = api.getState().ui.tables.errors.sql;
  assert.match(sql, /backend (=|IN)/);
  assert.equal(section.find("sql-filter-input").value, sql);
  // a re-render re-derives the checkbox from sql: it stays unchecked.
  api.render();
  assert.equal(box.checked, false);
});

test("Clear all filters resets sql + colFilters and shows every row", () => {
  const { root, api, section } = fresh();
  const sql = section.find("sql-filter-input");
  sql.value = "feldera"; sql.dispatch("input");
  assert.equal(visibleRowCount(section), 2);
  root.find("clear-filters-btn").click();
  assert.equal(api.getState().ui.tables.errors.sql, "");
  assert.equal(visibleRowCount(section), 3);
  assert.equal(sql.value, "");
});

test("collapse state survives a re-render (render is idempotent)", () => {
  const { api, section } = fresh();
  section.find("table-heading").click();
  assert.equal(section.classList.contains("collapsed"), true);
  api.render();                 // a stray re-render must not lose UI state
  assert.equal(section.classList.contains("collapsed"), true);
});

test("the lowest number in each row gets the cell-best class", () => {
  const root = new El("div");
  ctx.initEvalLive(root, {
    times: [
      { bench: "a", naive: 5, proofs: 2 },   // proofs lowest
      { bench: "b", naive: 1, proofs: 4 },   // naive lowest
    ],
  }, "T");
  const trs = root.findTag("tbody")._children;
  const best = (tr) => tr._children.filter((td) => td._classes.has("cell-best")).map((td) => td.textContent);
  assert.equal(JSON.stringify(best(trs[0])), JSON.stringify(["2"]));
  assert.equal(JSON.stringify(best(trs[1])), JSON.stringify(["1"]));
});

test("highlight selector switches lowest -> highest -> none", () => {
  const root = new El("div");
  ctx.initEvalLive(root, {
    times: [{ bench: "a", naive: 5, proofs: 2 }, { bench: "b", naive: 1, proofs: 4 }],
  }, "T");
  const section = root.find("table-section");
  const trs = section.findTag("tbody")._children;
  const best = (tr) => tr._children.filter((td) => td._classes.has("cell-best")).map((td) => td.textContent);
  const sel = section.find("highlight-control")._children.find((c) => c.tagName === "SELECT");
  // default lowest
  assert.equal(JSON.stringify(best(trs[0])), JSON.stringify(["2"]));
  // switch to highest
  sel.value = "highest"; sel.dispatch("change");
  assert.equal(JSON.stringify(best(trs[0])), JSON.stringify(["5"]));
  assert.equal(JSON.stringify(best(trs[1])), JSON.stringify(["4"]));
  // none -> nothing highlighted
  sel.value = "none"; sel.dispatch("change");
  assert.equal(best(trs[0]).length, 0);
});

test("computed-table columns come from optionRows, so they survive narrowing", () => {
  // Displayed rows (narrowed) omit the `error` key entirely; the unfiltered
  // optionRows still have it. The column must NOT vanish.
  const displayed = [{ file: "a.egg", status: "ok" }];
  const optionRows = [
    { file: "a.egg", status: "ok" },
    { file: "b.egg", status: "fail", error: "boom" },
  ];
  const view = ctx.buildTableView(
    "Summary", displayed, "computed", true, undefined, {}, optionRows);
  const headerTr = view.section.findTag("thead")._children[0];
  const headers = headerTr._children.map((th) => th.textContent).filter(Boolean);
  assert.deepEqual(headers, ["file", "status", "error"]);
  // The lone displayed row renders the missing cell as "" (cellText(undefined)).
  const firstBodyRow = view.section.findTag("tbody")._children[0];
  assert.equal(firstBodyRow._children.length, 4); // expand col + 3 data cols
});

test("styled cells render their text + apply inline style, and caption shows", () => {
  const rows = [
    { file: "a.egg", result: { text: "faster", style: { color: "green" } } },
    { file: "b.egg", result: { text: "slower", style: { color: "red", bold: true } } },
  ];
  const view = ctx.buildTableView(
    "Ratios", rows, "computed", false, "Ratio is target / baseline.", {}, rows);

  // caption is rendered (as the table description <p>)
  const desc = view.section.find("table-description");
  assert.ok(desc && desc.textContent.includes("target / baseline"), "caption missing");

  // styled cell -> its text, plus inline visual style (not the JSON dump)
  const bodyRows = view.section.findTag("tbody")._children;
  const good = bodyRows[0]._children[2]; // [expand, file, result]
  assert.equal(good.textContent, "faster");
  assert.equal(good.style.color, "green");
  const bad = bodyRows[1]._children[2];
  assert.equal(bad.textContent, "slower");
  assert.equal(bad.style.color, "red");
  assert.equal(bad.style.fontWeight, "600");
});

test("precomputed catalogs preserve order, sections, captions, and duplicate names", () => {
  const root = new El("div");
  const api = ctx.initEvalLiveTables(root, [
    {
      id: "__proto__",
      name: "Results",
      section: "Comparisons",
      caption: "First caption.",
      rows: [
        { target: "candidate", duration: { value: 120, text: "120 ms" } },
        { target: "baseline", duration: { value: 130, text: "130 ms" } },
      ],
    },
    {
      id: "constructor",
      name: "Results",
      section: "Summary",
      caption: "Second caption.",
      rows: [{ target: "candidate", duration: { value: 8, text: "8 ms" } }],
    },
    {
      id: "empty",
      name: "Empty",
      section: "Summary",
      columns: [
        { id: "first", name: "Value", alignment: "left" },
        { id: "second", name: "Value", alignment: "right" },
      ],
      rows: [],
    },
  ], "Benchmark");

  const sections = root.findAll("table-section");
  assert.deepEqual(sections.map((s) => s.find("table-title").textContent),
    ["Results", "Results", "Empty"]);
  assert.deepEqual(root.findAll("report-section-heading").map((h) => h.textContent),
    ["Comparisons", "Summary"]);
  assert.deepEqual(sections.slice(0, 2).map((s) => s.find("table-description").textContent),
    ["First caption.", "Second caption."]);
  const comparisonRows = sections[0].findTag("tbody")._children;
  const inferredHeaders = sections[0].findTag("thead")._children[0]._children.slice(1);
  assert.deepEqual(inferredHeaders.map((h) => h.textContent), ["target", "duration"]);
  assert.deepEqual(comparisonRows.map((r) => r._children[1].textContent), ["candidate", "baseline"]);
  assert.deepEqual(comparisonRows.map((r) => r._children[2].textContent), ["120 ms", "130 ms"]);
  assert.equal(sections[1].findTag("tbody")._children[0]._children[2].textContent, "8 ms");
  const emptyHeaders = sections[2].findTag("thead")._children[0]._children.slice(1);
  assert.deepEqual(emptyHeaders.map((h) => h.textContent), ["Value", "Value"]);
  assert.deepEqual(emptyHeaders.map((h) => h.style.textAlign), ["left", "right"]);
  assert.equal(sections[2].findTag("tbody")._children.length, 0);

  sections[0].find("table-heading").click();
  assert.equal(Object.getPrototypeOf(api.getState().ui.tables), null);
  assert.equal(api.getState().ui.tables.__proto__.collapsed, true);
  assert.equal(api.getState().ui.tables.constructor.collapsed, false);
});

test("precomputed report catalogs preserve table and message block order", () => {
  const root = new El("div");
  ctx.initEvalLiveCatalog(root, [
    {
      id: "timing",
      title: "Engine Timing",
      blocks: [
        { kind: "table", id: "compact", name: "a.egg", rows: [{ target: "main" }] },
        {
          kind: "message",
          id: "timing-caption",
          text: "Other is wall time minus recorded phases.",
          tone: "muted",
          layout: "caption",
        },
      ],
    },
    {
      id: "details",
      title: "Detailed Timing",
      blocks: [
        { kind: "table", id: "present", name: "main", rows: [{ ruleset: "simplify" }] },
        {
          kind: "message",
          id: "missing",
          title: "dd",
          text: "Status: missing result",
          tone: "warning",
        },
      ],
    },
    {
      id: "notes",
      title: "Notes",
      blocks: [{ kind: "message", id: "only-note", text: "No table required." }],
    },
  ]);

  const reportSections = root.findAll("precomputed-report-section");
  const children = reportSections.flatMap((section) => section._children);
  assert.deepEqual(reportSections.map((section) => section.dataset.sectionId),
    ["timing", "details", "notes"]);
  assert.deepEqual(
    children.map((child) => child.className),
    [
      "report-section-heading",
      "table-section",
      "report-message tone-muted layout-caption",
      "report-section-heading",
      "table-section",
      "report-message tone-warning layout-text",
      "report-section-heading",
      "report-message tone-default layout-text",
    ],
  );
  assert.deepEqual(root.findAll("report-section-heading").map((heading) => heading.textContent),
    ["Engine Timing", "Detailed Timing", "Notes"]);
  assert.deepEqual(root.findAll("table-title").map((title) => title.textContent), ["a.egg", "main"]);
  assert.deepEqual(root.findAll("report-message").map((message) => message.textContent), [
    "Other is wall time minus recorded phases.",
    "dd — Status: missing result",
    "No table required.",
  ]);
});

test("precomputed columns separate ids from duplicate labels and formatted values", () => {
  const root = new El("div");
  const api = ctx.initEvalLiveTables(root, [{
    id: "timings",
    name: "Timings",
    columns: [
      { id: "target", name: "Target" },
      { id: "duration", name: "Time", alignment: "right" },
      { id: "budget", name: "Time", alignment: "right" },
    ],
    rows: [
      {
        target: "slow",
        duration: { value: 120, text: "120 ms" },
        budget: { value: 10, text: "10 ms" },
      },
      {
        target: "fast",
        duration: { value: 8, text: "8 ms" },
        budget: { value: 10, text: "10 ms" },
      },
    ],
  }]);
  const section = root.find("table-section");
  const bodyRows = section.findTag("tbody")._children;
  const headers = section.findTag("thead")._children[0]._children.slice(1);

  assert.deepEqual(headers.map((h) => h.textContent), ["Target", "Time", "Time"]);
  assert.deepEqual(headers.map((h) => h.style.textAlign || ""), ["", "right", "right"]);
  assert.equal(bodyRows[0]._children[2].textContent, "120 ms");
  assert.equal(bodyRows[1]._children[2].textContent, "8 ms");
  assert.equal(bodyRows[0]._children[2].style.textAlign, "right");
  assert.equal(api.getState().ui.tables.timings.highlight, "none");
  assert.equal(bodyRows[0]._children[3].classList.contains("cell-best"), false);
  assert.equal(bodyRows[1]._children[2].classList.contains("cell-best"), false);

  const durationFilter = section.findAll("filter-input")[1];
  durationFilter.value = "8 ms";
  durationFilter.dispatch("input");
  assert.equal(api.getState().ui.tables.timings.colFilters.duration, "8 ms");
  assert.equal(api.getState().ui.tables.timings.colFilters.Time, undefined);
  assert.equal(visibleRowCount(section), 1);
  durationFilter.value = "";
  durationFilter.dispatch("input");

  const sql = section.find("sql-filter-input");
  sql.value = "duration < 10";
  sql.dispatch("input");
  assert.equal(visibleRowCount(section), 1);
  assert.equal(bodyRows[1].style.display, "");

  sql.value = "120 ms";
  sql.dispatch("input");
  assert.equal(visibleRowCount(section), 1);
  assert.equal(bodyRows[0].style.display, "");
});

test("reserved table and column ids are safe through state, DOM, and AlaSQL", () => {
  const root = new El("div");
  const rows = [
    { ["__proto__"]: "slow", constructor: 20, __eval_live_row_index: 7 },
    { ["__proto__"]: "fast", constructor: 5, __eval_live_row_index: 2 },
  ];
  const api = ctx.initEvalLiveTables(root, [{
    id: "__proto__",
    name: "Reserved",
    columns: [
      { id: "__proto__", name: "Kind" },
      { id: "constructor", name: "Value" },
      { id: "__eval_live_row_index", name: "Input index" },
    ],
    rows,
  }]);
  const section = root.find("table-section");
  const sql = section.find("sql-filter-input");

  const slowCheckbox = section.findAll("checkbox-item")[1]._children[0];
  slowCheckbox.checked = false;
  slowCheckbox.dispatch("change");
  assert.equal(sql.value, "source.__proto__ = 'fast'");
  assert.equal(visibleRowCount(section), 1);
  assert.equal(slowCheckbox.checked, false);
  slowCheckbox.checked = true;
  slowCheckbox.dispatch("change");
  assert.equal(sql.value, "");
  assert.equal(visibleRowCount(section), 2);

  const columnFilter = section.findAll("filter-input")[0];
  columnFilter.value = "fast";
  columnFilter.dispatch("input");
  assert.equal(api.getState().ui.tables.__proto__.colFilters.__proto__, "fast");
  assert.equal(visibleRowCount(section), 1);
  columnFilter.value = "";
  columnFilter.dispatch("input");

  sql.value = "source.constructor < 10 AND source.__eval_live_row_index < 5";
  sql.dispatch("input");
  assert.equal(visibleRowCount(section), 1);
  assert.equal(section.findTag("tbody")._children[1].style.display, "");

  sql.value = "source.__proto__ = 'fast'";
  sql.dispatch("input");
  assert.equal(visibleRowCount(section), 1);
});

test("legacy initEvalLive keeps ordinary objects containing value opaque", () => {
  const root = new El("div");
  ctx.initEvalLive(root, {
    values: [{ metadata: { value: 8, unit: "ms" }, comparison: 10 }],
  });
  const row = root.findTag("tbody")._children[0];
  assert.equal(row._children[1].textContent, '{"value":8,"unit":"ms"}');
  assert.equal(row._children.some((td) => td.classList.contains("cell-best")), false);
});

test("legacy initEvalLive accepts reserved table names", () => {
  const root = new El("div");
  const data = JSON.parse(`{
    "__proto__": [{"value": "first"}],
    "constructor": [{"value": "second"}]
  }`);
  const api = ctx.initEvalLive(root, data);
  const sections = root.findAll("table-section");
  assert.deepEqual(sections.map((s) => s.find("table-title").textContent),
    ["__proto__", "constructor"]);
  assert.equal(root.findAll("table-description").length, 0);
  sections[1].find("table-heading").click();
  assert.equal(api.getState().ui.tables.__proto__.collapsed, false);
  assert.equal(api.getState().ui.tables.constructor.collapsed, true);
});

test("legacy Pyodide inputs restore ordinary objects without losing reserved keys", () => {
  const data = ctx.dictionary();
  data.__proto__ = [Object.assign(ctx.dictionary(), { constructor: 8 })];
  const plain = ctx.plainInteropValue(data);

  assert.notEqual(Object.getPrototypeOf(plain), null);
  assert.equal(Object.prototype.hasOwnProperty.call(plain, "__proto__"), true);
  assert.notEqual(Object.getPrototypeOf(plain.__proto__[0]), null);
  assert.equal(plain.__proto__[0].constructor, 8);
});

test("precomputed table and column ids are required and unique", () => {
  const root = new El("div");
  assert.throws(
    () => ctx.initEvalLiveTables(root, [
      { id: "same", name: "A", rows: [] },
      { id: "same", name: "B", rows: [] },
    ]),
    /duplicate table id/,
  );
  assert.throws(
    () => ctx.initEvalLiveTables(root, [{
      id: "columns",
      name: "Columns",
      columns: [{ id: "same", name: "A" }, { id: "same", name: "B" }],
      rows: [],
    }]),
    /duplicate column id/,
  );
  assert.throws(
    () => ctx.initEvalLiveTables(root, [{
      id: "alignment",
      name: "Alignment",
      columns: [{ id: "value", name: "Value", alignment: "decimal" }],
      rows: [],
    }]),
    /alignment must be left, center, or right/,
  );
  assert.throws(
    () => ctx.initEvalLiveCatalog(root, [
      { id: "same", blocks: [] },
      { id: "same", blocks: [] },
    ]),
    /duplicate section id/,
  );
  assert.throws(
    () => ctx.initEvalLiveCatalog(root, [{
      id: "blocks",
      blocks: [
        { kind: "message", id: "same", text: "A" },
        { kind: "message", id: "same", text: "B" },
      ],
    }]),
    /duplicate block id/,
  );
  assert.throws(
    () => ctx.initEvalLiveCatalog(root, [{
      id: "message-style",
      blocks: [{ kind: "message", id: "bad-tone", text: "A", tone: "typo" }],
    }]),
    /tone is not supported/,
  );
});

console.log(`\n${passed} tests passed`);
