/* Part of eval-live -- SQL WHERE-clause filter (AlaSQL) + checkbox-clause helpers.
   Loaded as a plain <script> (global functions, no ES modules): js() concatenates
   all modules into one inline tag; index.html loads them as separate <script src>. */

/* =================================================================== *
 * SQL WHERE-clause filter, backed by AlaSQL (a real in-memory SQL engine,
 * vendored as the global `alasql` ahead of this file -- see eval_live.__init__).
 *
 * The per-table SQL filter box accepts an arbitrary SQL WHERE condition over
 * the row's columns (=, !=, <>, <, <=, >, >=, LIKE, IN, BETWEEN, AND/OR/NOT,
 * parentheses, ...) -- whatever AlaSQL's WHERE grammar supports -- and keeps
 * the rows for which it is true. We deliberately do NOT hand-roll a SQL parser;
 * AlaSQL evaluates the clause via `SELECT * FROM ? WHERE <clause>`.
 *
 * BACKWARD COMPATIBILITY: `sqlMatchSet` returns null when the text is not
 * a usable SQL condition -- a bare word like `feldera`, text typed mid-edit, or
 * anything AlaSQL rejects. Callers then fall back to the historic
 * substring-across-columns match, so plain-text filtering keeps working exactly
 * as before. A string is only treated as SQL when it actually contains a SQL
 * operator or keyword (see `looksLikeSql`). Note: unlike the old substring
 * filter, SQL string comparisons (e.g. `=`) are case-sensitive, matching real
 * SQL; use LIKE / UPPER(...) for case-insensitive matches.
 * =================================================================== */

// True only when the text uses a SQL operator/keyword; a bare word stays a
// substring match. Keeps `feldera` or a file path from being run as SQL.
function looksLikeSql(text) {
  return /(<=|>=|!=|<>|[<>=])|(\b(AND|OR|NOT|LIKE|IN|BETWEEN|IS|NULL)\b)/i.test(text);
}

/**
 * Evaluate a SQL WHERE clause over `rows` and return a Set of the indices that
 * match, or null if the text is not a usable SQL condition (caller falls back
 * to a substring match). Runs the clause ONCE via AlaSQL. A temporary index
 * column maps AlaSQL's result copies back to the originals.
 */
function sqlMatchSet(text, rows, columns) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  if (!looksLikeSql(trimmed)) return null;
  if (typeof alasql !== "function") return null;  // engine missing -> fallback
  // AlaSQL receives only the displayed columns and their semantic cell values.
  // Pick a synthetic identifier that cannot overwrite a caller's column.
  columns = columns || columnsOf(rows);
  let indexColumn = "__eval_live_row_index";
  while (columns.includes(indexColumn)) indexColumn = "_" + indexColumn;
  const tagged = rows.map((r, i) => {
    const values = dictionary();
    for (const column of columns) values[column] = cellValue(ownValue(r, column));
    values[indexColumn] = i;
    return values;
  });
  try {
    const res = alasql(`SELECT source.${indexColumn} AS ${indexColumn} FROM ? AS source WHERE ` + trimmed,
      [tagged]);
    return new Set(res.map((r) => ownValue(r, indexColumn)));
  } catch (e) {
    return null;  // invalid / half-typed SQL -> substring fallback
  }
}

/* ---- Checkbox-clause helpers ------------------------------------- *
 * Checkbox dropdowns generate a clause like `backend IN ('a','b')` for a
 * column and merge it into the SQL filter box. A column's generated clause
 * is tracked verbatim (in `managedClauses`) so it can be found and replaced
 * without disturbing whatever else the user typed. */

function sqlQuote(v) {
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// AlaSQL resolves JavaScript prototype names specially when unqualified. The
// source alias keeps generated checkbox clauses safe for those column ids.
function sqlColumnReference(col) {
  return Object.prototype.hasOwnProperty.call(Object.prototype, col) ? `source.${col}` : col;
}

// The clause a set of checked values produces for a column. Empty checkedSet
// (or all-checked, handled by caller) means "no constraint" -> "".
function clauseForColumn(col, checkedValues) {
  if (checkedValues.length === 0) return "";
  const reference = sqlColumnReference(col);
  if (checkedValues.length === 1) return `${reference} = ${sqlQuote(checkedValues[0])}`;
  return `${reference} IN (${checkedValues.map(sqlQuote).join(", ")})`;
}
