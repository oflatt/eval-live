/* End-to-end smoke test of the DOM layer with a tiny hand-rolled DOM shim (no
   jsdom / npm). It drives the real initEvalLive through the raw-tables path (no
   graph script, so no Pyodide) and asserts the state<->DOM wiring: filtering
   hides rows, the heading collapses the section, checkboxes filter rows independently of SQL, and "Clear all filters" resets everything.

   The shim implements only what these modules touch. Run: `node test/dom.test.mjs`. */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

// ---- minimal DOM shim -----------------------------------------------------
class El {
  constructor(tag) {
    this.tagName = (tag || "div").toUpperCase();
    this._children = [];
    this._classes = new Set();
    this._text = "";
    this._listeners = {};
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
  set textContent(v) { this.innerHTML = ""; this._text = String(v); }
  get textContent() {
    return (this._text || "") + this._children.map((c) => c.textContent).join("");
  }
  set innerHTML(v) {
    for (const child of this._children) child.parentNode = null;
    this._children = []; this._text = "";
  }
  get innerHTML() { return ""; }
  get children() { return this._children; }
  appendChild(c) { c.remove(); this._children.push(c); c.parentNode = this; return c; }
  insertBefore(c, before) {
    c.remove();
    this._children.splice(before ? this._children.indexOf(before) : this._children.length, 0, c);
    c.parentNode = this;
    return c;
  }
  remove() {
    if (this.parentNode) this.parentNode._children.splice(this.parentNode._children.indexOf(this), 1);
    this.parentNode = null;
  }
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
vm.createContext(ctx);
for (const f of ["sql-filter.js", "state.js", "table-view.js", "graph-engine.js", "eval-live.js"]) {
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
  assert.equal(api.getState().ui.tables[ctx.tableKey("errors")].sql, "flowlog");
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

test("checkboxes filter rows without rewriting the SQL control", () => {
  const { api, section } = fresh();
  const box = section.findAll("checkbox-item")[0]._children[0];
  box.checked = false;
  box.dispatch("change");
  assert.equal(section.find("sql-filter-input").value, "");
  assert.equal(visibleRowCount(section), 1);
  api.render();
  assert.equal(section.findAll("checkbox-item")[0]._children[0], box);
  assert.equal(box.checked, false);
});

test("Clear all filters resets sql + colFilters and shows every row", () => {
  const { root, api, section } = fresh();
  const sql = section.find("sql-filter-input");
  sql.value = "feldera"; sql.dispatch("input");
  assert.equal(visibleRowCount(section), 2);
  root.find("clear-filters-btn").click();
  assert.equal(api.getState().ui.tables[ctx.tableKey("errors")].sql, "");
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
  const trs = () => section.findTag("tbody")._children;
  const best = (tr) => tr._children.filter((td) => td._classes.has("cell-best")).map((td) => td.textContent);
  const sel = section.find("highlight-control")._children.find((c) => c.tagName === "SELECT");
  // default lowest
  assert.equal(JSON.stringify(best(trs()[0])), JSON.stringify(["2"]));
  // switch to highest
  sel.value = "highest"; sel.dispatch("change");
  assert.equal(JSON.stringify(best(trs()[0])), JSON.stringify(["5"]));
  assert.equal(JSON.stringify(best(trs()[1])), JSON.stringify(["4"]));
  // none -> nothing highlighted
  sel.value = "none"; sel.dispatch("change");
  assert.equal(best(trs()[0]).length, 0);
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

test("checkbox DOM state distinguishes scalar types independently of SQL", () => {
  ctx.alasql = createRequire(import.meta.url)("../eval_live/vendor/alasql.min.js");
  const root = new El("div");
  const api = ctx.initEvalLive(root, {values: [true, "true", "A", "a", null, ""].map(value => ({value}))});
  const section = root.find("table-section");
  const sql = section.find("sql-filter-input");
  for (const label of ["true", '\"true\"', '\"A\"', "(null / missing)", "(empty string)"]) {
    const items = section.findAll("checkbox-item");
    for (const item of items) item._children[0].checked = item.textContent === label;
    items.find(item => item.textContent === label)._children[0].dispatch("change");
    api.render();
    assert.equal(visibleRowCount(section), 1);
    assert.equal(sql.value, "");
    const checked = section.findAll("checkbox-item").filter(el => el._children[0].checked);
    assert.deepEqual(checked.map(el => el.textContent), [label]);
  }
  sql.value = "[value] = 'A'";
  sql.dispatch("input");
  assert.equal(visibleRowCount(section), 0);
  root.find("clear-filters-btn").click();
  assert.equal(visibleRowCount(section), 6);
});

test("result replacement preserves controls, selections, and column alignment", () => {
  const rows = [{a: 1, b: 2}, {a: 3, b: 4}];
  const state = ctx.makeState({}, "Report", "python");
  state.engine.status = "ready";
  const view = ctx.buildTableView("Summary", rows, "computed", true, null, {});
  ctx.setColFilter(state, "Summary", "b", "2", "computed");
  view.sync(state);
  const input = view.section.findAll("filter-input")[1];
  document.activeElement = input;
  const oldRow = view.section.findTag("tbody")._children[0];
  view.update([{c: 0, a: 1, b: 2}], rows);
  view.sync(state);
  assert.equal(view.section.findAll("filter-input")[2], input);
  assert.equal(document.activeElement, input);
  assert.notEqual(view.section.findTag("tbody")._children[0], oldRow);
  assert.deepEqual(view.section.findTag("thead")._children[0]._children.slice(1).map(n => n.textContent), ["c", "a", "b"]);
  assert.deepEqual(view.section.findTag("tbody")._children[0]._children.slice(1).map(n => n.textContent), ["0", "1", "2"]);
  view.update([], []);
  view.sync(state);
  assert.equal(view.section.findAll("filter-input")[2], input);
  assert.equal(visibleRowCount(view.section), 0);
  document.activeElement = null;
});

test("raw values wait for computed narrowing and stay hidden on failure", () => {
  const rows = [{value: 1}, {value: 2}];
  const state = ctx.makeState({samples: rows}, "Report", "python");
  const view = ctx.buildTableView("samples", rows, "raw", true, null, {});
  ctx.setSql(state, "Summary", "value > 0", "computed");
  view.sync(state);
  assert.equal(visibleRowCount(view.section), 0);
  assert.equal(view.section.find("row-count").textContent, "(updating)");
  state.engine.status = "ready";
  state.engine.narrowing = {samples: [rows[1]]};
  view.sync(state);
  assert.equal(visibleRowCount(view.section), 1);
  state.engine.status = "error";
  state.engine.narrowing = null;
  view.sync(state);
  assert.equal(visibleRowCount(view.section), 0);
  assert.equal(view.section.find("row-count").textContent, "(unavailable)");
});

console.log(`\n${passed} tests passed`);
