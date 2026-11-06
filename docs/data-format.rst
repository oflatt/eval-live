Data format and provenance
==========================

The data/cache file is one JSON object mapping names to lists of row objects.
Every stored cell is a string, finite number, boolean, or null. Metadata uses
reserved ``eval_`` names. User tables reference observations through ``run_id``.
Do not put styled cells, lists, dictionaries, or serialized configuration
objects in stored cells. Styled cells are allowed in derived presentation tables.

Schema version 1
----------------

======================= ======================================================
Table                   Contents
======================= ======================================================
``eval_metadata``       Singleton schema and writer versions.
``eval_invocations``    Invocation identity, timestamps/status, script identity,
                        script Git revision/dirty state, Python/platform, cwd,
                        and whether collection completed.
``eval_argv``           Invocation ID, original token position and token.
``eval_arguments``      All resolved invocation options, with scalar types and
                        list positions, including defaults and empty lists.
``eval_configs``        Request, measurement-argument, and build parameters,
                        grouped by config ID and scope.
``eval_environments``   Environment ID and named platform/Python/tool settings.
``eval_runs``           Attempt ID, collecting invocation, benchmark, resolved
                        commit/ref, cache identity, configuration/environment,
                        data version, status, timing, binary hash, error, and
                        ``has_rows`` for attempts with declared result rows.
``eval_inputs``         Run ID, declared input path and SHA-256.
``eval_selections``     Rendering invocation, artifact, named requirement,
                        position, and selected run ID (fresh or reused).
``eval_requirements``   Rendering invocation, artifact, and requirement name,
                        including requirements with no selected observations.
``eval_processes``      Process ID, run, cwd, duration, status, exit code, logs.
``eval_commands``       Process/run ID and ordered command argument values.
User tables             Scalar measurement rows with library-supplied run ID.
======================= ======================================================

Parameter encoding distinguishes scalar, list, empty-list, and empty-mapping
kinds. Each value has an explicit type, so ``1``, ``1.0``, ``"1"``, and
``true`` remain distinct. List items have ordered indices. Empty lists/maps
use a marker row with index -1 and null value. Paths in CLI arguments normalize
to strings. A configuration's three scopes are ``request``, ``arguments``, and
``build``.

Rows and selections
-------------------

``run_id`` links measurement rows to a treatment's configuration and commit.
``eval_selections`` records the exact attempts used by each output, including
reused results. Repeated or forced evaluations retain earlier attempts.

Every requested treatment has rows in every table declared by ``error_rows``
before collection begins. ``has_rows=True`` identifies attempts covered by
this invariant. ``eval_runs.status`` is one of ``pending``, ``running``,
``success``, ``timed-out``, ``failure``, or ``interrupted``. Error rows satisfy
output requirements just as measured rows do. Unfinished attempts from a
stopped writer become ``interrupted`` when the next writer starts.

``eval_runs.data_version`` is the benchmark's declared table/protocol version.
Changing it creates a new cache identity; saved attempts keep their version.
It is independent of the file's ``schema_version``.

``eval_runs.timeout`` is the per-command deadline in seconds, or null for no
limit. ``seconds`` is elapsed attempt time, including preparation and builds.
Each attempt keeps the deadline it used. The :doc:`python-guide` describes
cache reuse when the deadline changes.

``eval_invocations.collection_complete`` records that all requested treatments
finished, including those represented by timeout or failure rows. Rendering
may still report errors. Render-only mode defaults to the latest invocation
with completed collection and uses its saved selections.

Computed warning/error tables are rendering outputs and are never added to
this file. Execution diagnostics in ``eval_runs`` and ``eval_processes`` are
stored facts that figures can use when computing those messages.

Persistence
-----------

``Store`` validates scalar cells, schema version, identities, parameter
encoding, provenance links, and cache fingerprints before collection.
Incompatible data raises an error; it is never silently deleted or converted.
The current repository identity is the canonical common Git-directory path,
so another clone has a separate collection identity. Stored selections remain
portable for render-only use.

Writes are atomic: readers see the complete previous or new snapshot. One
writer holds ``results.json.lock``; concurrent writers fail immediately. The
lock file can remain after exit, but the lock is released when the writer
stops. Benchmark results are stored only in the JSON file.

The generated HTML contains the union of runs referenced by the selected
figures, tables, and macros. This includes reused attempts and comparisons
across commits, with their configurations, environments, inputs, command
logs, and collecting invocations. It also includes the current invocation's
arguments and output selections, plus any replay ancestry. Empty requirements
remain represented. Unrelated attempts and historical output selections stay
in the JSON database and are not embedded in the page.
