/* Part of eval-live -- SQL WHERE-clause filter (AlaSQL).
   Loaded as a plain <script> (global functions, no ES modules): js() concatenates
   all modules into one inline tag; index.html loads them as separate <script src>. */

/* SQL filter boxes accept AlaSQL WHERE conditions. Bare text and rejected
   SQL fall back to case-insensitive substring matching across columns.
   SQL string comparisons are case-sensitive; use UPPER(...) or LIKE as needed. */

// Require a SQL operator or keyword before trying the query engine.
function looksLikeSql(text) {
  return /(<=|>=|!=|<>|[<>=])|(\b(AND|OR|NOT|LIKE|IN|BETWEEN|IS|NULL)\b)/i.test(text);
}

/**
 * Evaluate a SQL WHERE clause over `rows` and return a Set of the indices that
 * match, or null if the text is not a usable SQL condition (caller falls back
 * to a substring match). Runs the clause ONCE via AlaSQL. A temporary index
 * column maps AlaSQL's result copies back to the originals.
 */
function sqlMatchSet(text, rows) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  if (!looksLikeSql(trimmed)) return null;
  if (typeof alasql !== "function") return null;  // engine missing -> fallback
  // `__el_idx` is unlikely to collide with a real column.
  const tagged = rows.map((r, i) => ({ ...r, __el_idx: i }));
  const cache = alasql.options.cache;
  try {
    // AlaSQL's compiled-query cache conflates some typed literals, including
    // TRUE and 'true'. Recompile the exact filter on every evaluation.
    alasql.options.cache = false;
    const res = alasql("SELECT __el_idx FROM ? WHERE " + trimmed, [tagged]);
    return new Set(res.map((r) => r.__el_idx));
  } catch (e) {
    return null;  // invalid / half-typed SQL -> substring fallback
  } finally {
    alasql.options.cache = cache;
  }
}
