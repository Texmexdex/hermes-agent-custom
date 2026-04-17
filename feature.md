# Feature: Workspace FTS5 Indexing & Search (Phase 1)

> First pass: get workspace indexing and full-text search working end-to-end.
> No agent runtime hookup, no vector search, no file watcher, no plugin system.
> Clean code in a new `workspace/` package with overrideable base classes added in a second pass.

---

## What We're Building

A local document indexing and search system. Users point Hermes at directories,
files get indexed into SQLite FTS5, and search returns ranked results with line
numbers so the agent can jump straight to `read_file(path, start=142, end=198)`.

This is the foundation layer. It runs standalone via CLI and Python API. It does
not inject context into conversations or register as an agent tool — that wiring
comes later once we've validated the core works well.

---

## Chunking: Chonkie

We use [Chonkie](https://github.com/chonkie-inc/chonkie) for all chunking.
It's an optional dependency under `hermes-agent[workspace]`.

### Three-Path Dispatch by File Extension

| File type | Pipeline | Chunker |
|-----------|----------|---------|
| Markdown (`.md`, `.mdx`) | MarkdownChef → RecursiveChunker | `RecursiveChunker.from_recipe("markdown")` — heading-aware splits. MarkdownChef pre-processes to extract tables, code blocks, images as structured metadata. |
| Code (`.py`, `.js`, `.ts`, `.rs`, `.go`, etc.) | CodeChunker | `CodeChunker(language="auto")` — tree-sitter AST-based splitting. Language auto-detected via Magika. |
| Everything else | RecursiveChunker | `RecursiveChunker()` — default paragraph/sentence/word rules. |

### Chunker Fallback Chain

If a specialized chunker (markdown or code) fails for a file, it falls back to
the default `RecursiveChunker`. The code path already does this; markdown and
other specialized paths get the same treatment. The default chunker is assumed
not to fail — if it does, the file is skipped and reported as an error.

### Overlap

The `overlap` config value (`knowledgebase.chunking.overlap`, default 80 words)
is passed to all chunker constructors as `chunk_overlap`. This creates
overlapping windows between adjacent chunks, improving search recall for content
that falls on chunk boundaries.

### Tokenizer and Threshold

- **Tokenizer**: Chonkie's built-in **word tokenizer** (`tokenizer="word"`).
  `chunk_size=512` means 512 words per chunk.
- **Threshold**: Files under **16,000 words** are stored as a single FTS5 row
  with no chunking. Files over 16K words go through the chunking pipeline.
- The same word tokenizer is used for both the threshold check and chunking,
  so the two are always consistent.

### Chonkie Recipe Caching

The markdown recipe is fetched from HuggingFace Hub on first use and cached
locally in `~/.cache/chonkie/`. Subsequent runs are fully offline.

### Without Chonkie Installed

If `chonkie` is not installed (user didn't `pip install hermes-agent[workspace]`),
**indexing is blocked entirely** with a clear error message directing them to
install the extra. No partial behavior, no silent degradation.

---

## Storage: SQLite FTS5

### Database Location

```
~/.hermes/workspace/.index/workspace.sqlite
```

Hidden `.index/` directory inside the workspace tree. Keeps index artifacts
close to the content they index without cluttering the user's file view.

### Schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Key-value metadata store
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- One row per indexed file
CREATE TABLE IF NOT EXISTS files (
    abs_path         TEXT PRIMARY KEY,
    root_path        TEXT NOT NULL,
    content_hash     TEXT NOT NULL,
    config_signature TEXT NOT NULL,
    size_bytes       INTEGER NOT NULL,
    modified_at      TEXT NOT NULL,
    indexed_at       TEXT NOT NULL,
    chunk_count      INTEGER NOT NULL DEFAULT 0
);

-- One row per chunk (or one row for the whole file if < 16K words)
CREATE TABLE IF NOT EXISTS chunks (
    chunk_id    TEXT PRIMARY KEY,
    abs_path    TEXT NOT NULL REFERENCES files(abs_path) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content     TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    start_line  INTEGER NOT NULL,
    end_line    INTEGER NOT NULL,
    start_char  INTEGER NOT NULL,
    end_char    INTEGER NOT NULL,
    section     TEXT,
    kind        TEXT NOT NULL,
    UNIQUE(abs_path, chunk_index)
);

-- FTS5 full-text index with porter stemming
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    chunk_id UNINDEXED,
    abs_path UNINDEXED,
    content,
    section,
    tokenize = 'porter unicode61'
);

-- Keep FTS5 in sync
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(chunk_id, abs_path, content, section)
    VALUES (new.chunk_id, new.abs_path, new.content, new.section);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    DELETE FROM chunks_fts WHERE chunk_id = old.chunk_id;
END;
```

### Key Design Decisions

- **Porter stemmer**: `deploying` matches `deployment`. Better recall for
  English-heavy knowledge bases.
- **Line numbers stored at index time**: Computed from character offsets during
  indexing. Recomputed on every re-index. May be stale if file is edited between
  indexes — content hash check on next index fixes this naturally.
  `end_line` represents the last line with content (uses `splitlines()`), not
  the total line count — a 142-line file ending with `\n` reports `end_line=142`.
- **Character offsets, not byte offsets**: Chonkie returns Python string
  positions (`start_index`, `end_index`), which are character offsets. There is
  no configuration to get byte offsets from Chonkie. The schema stores
  `start_char`/`end_char` to reflect this accurately.
- **CASCADE deletes**: Deleting a file row automatically deletes its chunks.
- **WAL mode**: Concurrent reads while indexing.

---

## Re-Indexing Strategy

Two checks per file to decide whether to re-index:

1. **Content hash** (SHA-256 of file bytes): Changed file content → re-index.
2. **Config signature** (hash of chunker config: chunk_size, overlap, tokenizer,
   threshold): Changed chunker settings → re-index even if file content is the same.

If both match the stored values, the file is skipped.

**Stale file pruning**: On every index run, compare the set of files currently on
disk against the set of indexed paths. Any indexed path that no longer exists on
disk is deleted from the index (CASCADE removes its chunks too).

---

## File Discovery and Filtering

### Workspace Roots

The primary workspace root is `~/.hermes/workspace/`. Additional roots are added
via CLI (`hermes workspace roots add <path>`). Each root can be recursive or
non-recursive (non-recursive is the default — prevents accidentally indexing
massive trees).

**Overlapping roots are allowed.** If two roots contain the same file, it gets
indexed twice. This is the user's problem to manage.

**Symlinked roots** are resolved to their real path via `resolve()`. Search
results point to the resolved path, not the symlink.

### Exclusions

Three mechanisms:

1. **Hardcoded binary suffixes**: A frozenset of known binary extensions
   (`.png`, `.jpg`, `.exe`, `.so`, `.wasm`, `.zip`, `.tar`, `.gz`, `.mp3`,
   `.mp4`, `.mov`, `.pdf`, `.docx`, `.svg`, `.lock`, etc.). Skipped
   unconditionally. `.svg` and `.lock` are intentionally included despite being
   text-based — they are rarely useful search targets and lock files can be huge.

2. **Ignore file precedence** (per root, first match wins):
   1. `root/.hermesignore` — Hermes-specific rules for this root.
   2. `root/.gitignore` — automatic fallback if no `.hermesignore` exists.
      Most projects already have a `.gitignore` that excludes `node_modules/`,
      `__pycache__/`, build outputs, etc.
   3. Seeded Hermes default rules — last-resort baseline when neither file
      exists. Applied from a built-in pattern set (see Default .hermesignore
      below).

   All ignore files are parsed by [pathspec](https://pypi.org/project/pathspec/)
   with full gitignore semantics: negation (`!pattern`), directory rules, `**`
   recursive globs.

   **No hardcoded dotfile filtering.** Unlike the initial implementation, there
   is no `_is_hidden()` check. Dotfiles and dotdirs are handled entirely through
   ignore patterns, consistent with how `.gitignore` works. The default ignore
   rules exclude `.git/`, `.svn/`, `.hg/`, `.DS_Store`, etc.

3. **Max file size**: Files over `max_file_mb` (default 10MB) are skipped.

### Default .hermesignore

Seeded into the **configured primary workspace root**
(`workspace.path` if set, otherwise `HERMES_HOME/workspace`) on first init.
Only created if the file does not already exist — user edits are never
overwritten. Comprehensive GitHub-style template:

```gitignore
# Version control
.git/
.svn/
.hg/

# OS files
.DS_Store
Thumbs.db
Desktop.ini

# IDE / editor
.idea/
.vscode/
*.swp
*.swo
*~

# Python
__pycache__/
*.pyc
*.pyo
.tox/
.venv/
venv/
.env/
*.egg-info/
.eggs/
dist/
build/

# JavaScript / Node
node_modules/
bower_components/
.npm/
.yarn/

# Build outputs
target/
out/
_build/

# Hermes internals
.index/
```

### Encoding Detection

Files are read with the following precedence:

1. Try **UTF-8 strict** decoding.
2. On failure, run **charset-normalizer** detection.
   - If confidence ≥ **0.5**, decode with the detected encoding.
   - If confidence < 0.5, **skip the file** and report an error
     (`stage: "read"`, `error_type: "EncodingError"`).
3. No `errors="replace"` fallback — lossy indexing is not allowed because
   replacement characters (U+FFFD) produce unsearchable content.

`charset-normalizer` is a base dependency (pure Python, ~200KB).

---

## Search

### Plain Free-Text Search over FTS5

Users and agents type normal search terms. Hermes compiles the input into a
safe FTS5 MATCH expression internally. **No FTS5 query syntax is exposed** —
operators like `AND`, `OR`, `NOT`, `NEAR`, and column filters (`section:`) are
treated as ordinary words, not FTS5 commands. Filters stay as first-class CLI
flags (`--path`, `--glob`), not embedded query syntax.

### Query Normalization (`_build_fts_query`)

`_build_fts_query()` transforms raw user input into a safe FTS5 query:

1. **Tokenize** using `re.findall(r'[^\W_]+', query)` — Unicode letters and
   digits, excluding underscores. This matches how the `porter unicode61`
   tokenizer splits indexed content.

2. **Filter**: Drop tokens shorter than 2 characters.

3. **Detect compound terms**: If the original input contained hyphenated
   (`hermes-agent`) or underscored (`read_file`) terms, their sub-tokens are
   grouped as compounds.

   **Phase 1 scope:** Only hyphenated and underscored compounds are
   special-cased. Dotted names, slashed paths, and version-like inputs
   (`workspace/store.py`, `foo.bar`, `gpt-4.1`) fall back to normal tokenization
   and may lose short fragments via the minimum-token filter. This is
   intentional for phase 1 and can be revisited once reranking lands.

4. **Generate FTS5 expression**:
   - Every token is **double-quoted** to prevent FTS5 operator injection.
     `"NOT"` is a literal search for the word "not", not an FTS5 operator.
   - **Simple words** are joined with `OR`:
     `container CLI` → `"container" OR "cli"`
   - **Compound terms** (hyphenated/underscored) require all parts via AND,
     with a phrase boost for adjacency:
     `hermes-agent` → `("hermes agent" OR ("hermes" AND "agent"))`
   - **Mixed queries** combine both:
     `hermes-agent deployment` → `("hermes agent" OR ("hermes" AND "agent")) OR "deployment"`

5. FTS5 handles porter stemming and BM25 scoring from there.

### Search Result Shape

Flat JSON, no wrapper:

```json
[
  {
    "path": "/abs/path/to/src/deploy/rollback.py",
    "line_start": 142,
    "line_end": 198,
    "section": "## Rollback Procedures",
    "chunk_index": 7,
    "score": -12.3,
    "tokens": 284,
    "modified": "2026-04-15T10:32:00Z",
    "content": "The rollback controller checks the previous..."
  }
]
```

All paths are **absolute**. Directly usable in `read_file(path, start=142, end=198)`.

### Search Filters

- `--path <prefix>`: Filter by absolute path prefix (SQL `LIKE`).
- `--glob <pattern>`: Filter by filename glob (e.g., `*.py`).
- `--limit <N>`: Max results (default 20). Clamped to ≥ 1 — negative or zero
  values are replaced with the default.

---

## CLI Commands

All commands default to **JSON output** (agent-first design — the agent is the
primary consumer). Add `--human` for Rich-formatted terminal output.

**Note:** `--human` is a flag on the `workspace` parser and must appear before
the subcommand: `hermes workspace --human search "query"`, not
`hermes workspace search "query" --human`.

### `hermes workspace roots list`

```json
[
  {"path": "/Users/sid/projects/backend", "recursive": false},
  {"path": "/Users/sid/notes", "recursive": true}
]
```

### `hermes workspace roots add <path> [--recursive]`

Adds a workspace root. Non-recursive by default.

### `hermes workspace roots remove <path>`

Removes a workspace root from config.

### `hermes workspace index`

Full re-index of all workspace roots. Shows a **Rich progress bar** on stderr
(even in JSON mode) reporting:

```
Indexing [3/12] /Users/sid/notes/deployment.md
```

Returns summary as JSON on stdout:

```json
{
  "files_indexed": 12,
  "files_skipped": 3,
  "files_pruned": 1,
  "files_errored": 2,
  "chunks_created": 47,
  "duration_seconds": 1.8,
  "errors": [
    {
      "path": "/repo/tmp/live.txt",
      "stage": "discover",
      "error_type": "FileNotFoundError",
      "message": "[Errno 2] No such file or directory"
    },
    {
      "path": "/repo/docs/bad.md",
      "stage": "chunk",
      "error_type": "RuntimeError",
      "message": "Markdown chunker failed"
    }
  ],
  "errors_truncated": false
}
```

Error stages: `discover` (file vanished between walk and read), `read`
(encoding failure), `chunk` (chunker crash), `store` (database error).
The `errors` list is capped at **50 entries**. If more errors occurred,
`errors_truncated` is `true` and the full count is in `files_errored`.
Full tracebacks go to Python logging.

In `--human` mode, errors are printed as a short section after the summary
line. Partial failures do not abort the run — each file is processed
independently.

### `hermes workspace search <query> [--path <prefix>] [--glob <pattern>] [--limit N]`

Returns flat JSON array of search results (see Search Result Shape above).

---

## Configuration

### Config Location

Workspace config keys and defaults live in `workspace/constants.py` (zero
internal dependencies). This avoids circular imports between `workspace/` and
`hermes_cli/`.

`hermes_cli/config.py` imports defaults from `workspace/constants.py` and
includes them in the main `~/.hermes/config.yaml` schema.

### Config Keys

```yaml
workspace:
  enabled: true          # master toggle — directory structure created when true
  path: ""               # empty = HERMES_HOME/workspace

knowledgebase:
  roots: []              # [{path: "/abs/path", recursive: false}]
  chunking:
    chunk_size: 512      # words per chunk (must be > 0)
    overlap: 80          # word overlap between chunks (must be ≥ 0, < chunk_size)
    threshold: 16000     # words — files under this stored as single row (must be ≥ 0)
  indexing:
    max_file_mb: 10      # skip files over this size (must be > 0)
  search:
    default_limit: 20    # default result count (must be ≥ 1)
```

### Config Validation

`WorkspaceConfig.from_dict()` validates all values at config load time and
raises `ValueError` with a clear message for invalid values. This means any
command that loads config (`roots list`, `index`, `search`) will fail early
if the config is broken — no raw tracebacks from downstream code.

Validated constraints:
- `chunk_size > 0`
- `0 ≤ overlap < chunk_size`
- `threshold ≥ 0`
- `max_file_mb > 0`
- `default_limit ≥ 1`

---

## Directory Structure

Created when `workspace.enabled` is `true` (which is the default):

```
~/.hermes/workspace/
  .index/
    workspace.sqlite     # FTS5 index database
  .hermesignore          # gitignore-style exclusion patterns
  docs/
  notes/
  data/
  code/
  uploads/
  media/
```

Each Hermes profile gets its own workspace directory.

---

## Package Layout

```
workspace/
  __init__.py            # Public API surface
  constants.py           # Config keys, defaults, path helpers, BINARY_SUFFIXES
  types.py               # Dataclasses: FileRecord, ChunkRecord, SearchResult
                         #   (salvaged from PR #5840, trimmed — no dense/rerank fields)
  config.py              # WorkspaceConfig dataclass, loads from config.yaml
  store.py               # SQLiteFTS5Store — schema creation, CRUD, search
  indexer.py             # Index pipeline: discover files → parse → chunk → store
  search.py              # Search API: query → FTS5 → SearchResult list
  files.py               # File discovery, .hermesignore parsing, binary filtering
```

### Dependency Graph

```
workspace/constants.py      (zero internal deps — config keys, defaults, BINARY_SUFFIXES)
         ↑              ↑
workspace/types.py      hermes_cli/config.py
         ↑
workspace/{config,store,files,indexer,search}.py
         ↑
hermes_cli/workspace_commands.py
```

No circular dependencies.

---

## Dependencies

### Required (workspace/ package itself)

- `pathspec` — .hermesignore / .gitignore parsing
- `charset-normalizer` — encoding detection for non-UTF8 files

### Optional Extra: `hermes-agent[workspace]`

- `chonkie` — core chunking
- `chonkie[code]` — CodeChunker (tree-sitter + magika)

Without this extra, `hermes workspace index` errors with a clear message.

---

## Store Base Class (Second Pass)

First pass: `SQLiteFTS5Store` is a concrete class with no ABC. It works.

Second pass: extract a `WorkspaceStore` ABC from the concrete implementation,
so someone can swap in a different backend (PostgreSQL, DuckDB, external vector
DB) by subclassing. The ABC will cover: `open`, `close`, `upsert_file`,
`delete_file`, `insert_chunks`, `search`, `get_file_record`, `all_indexed_paths`,
`status`.

This is deliberate — you can't design a good abstract interface without first
having a working concrete implementation to extract from.

---

## Types (Salvaged from PR #5840)

Trimmed versions of `agent/workspace_types.py` from PR #5840. Removed:
- `WorkspaceHit.dense_score`, `WorkspaceHit.rerank_score` (no dense/reranking)
- `WorkspaceQuery` (search uses simple function parameters)
- `WorkspacePluginContext` (no plugin system)
- `PluginHealth` (no plugin system)

Kept/adapted:
- `FileRecord` — maps to `files` table row
- `ChunkRecord` — maps to `chunks` table row, with `start_line`,
  `end_line`, `start_char`, `end_char`, `section`, `kind`
- `SearchResult` — flat result with all fields the agent needs
- `BINARY_SUFFIXES` — frozenset of extensions to skip
- `IndexSummary` — returned by index command, with `files_errored`,
  `errors` (list of `IndexError`), `errors_truncated`
- `IndexError` — `path`, `stage`, `error_type`, `message`

---

## Testing Plan

A sub-agent will be launched to exercise the full system and provide critical
feedback. The test plan:

1. **Setup**: Create a temp workspace with diverse files — markdown with headings,
   Python/JS code, plain text, a binary file, a large file (>16K words), an empty
   file, a file with unicode, nested directories.
2. **Roots management**: Add/remove/list roots via Python API and CLI.
3. **Indexing**: Run full index, verify progress reporting, check that binary
   and oversized files are skipped, verify chunk counts and line numbers.
4. **Search quality**: Run targeted queries, verify BM25 ranking makes sense,
   check that section headings are extracted correctly for markdown, verify
   line numbers allow accurate `read_file` calls.
5. **Re-indexing**: Modify a file, re-index, verify only the changed file is
   re-processed. Delete a file, re-index, verify stale entries are pruned.
6. **Edge cases**: Empty query, query with no results, overlapping roots,
   .hermesignore patterns, files at max_file_mb boundary.
7. **Performance**: Time indexing of 100+ files, measure search latency.
8. **Design feedback**: Report on API ergonomics, result format usefulness,
   chunking quality, any surprising behavior.

---

## Verification & Merge Gate

The feature is **not ready to ship** until the following verification steps
pass cleanly.

### Automated Test Coverage

Add a dedicated `tests/workspace/` suite with at least these modules:

- `tests/workspace/test_files.py`
  - ignore precedence: `.hermesignore` → `.gitignore` → seeded defaults
  - dotfiles/dotdirs handled by ignore rules, not hardcoded hidden filtering
  - binary/oversized/empty file skipping
  - file vanishing during discovery is skipped, not fatal
- `tests/workspace/test_config.py`
  - valid config loads successfully
  - invalid values (`chunk_size=0`, `overlap>=chunk_size`, negative threshold,
    negative/default_limit, invalid max_file_mb) fail early with `ValueError`
- `tests/workspace/test_store.py`
  - `_build_fts_query()` handles reserved words safely
  - hyphenated and underscored compound queries normalize as specified
  - unicode tokenization (`café`, `naïve`) is preserved
  - `limit` is clamped to ≥ 1
- `tests/workspace/test_indexer.py`
  - markdown/code/default chunkers receive `chunk_overlap`
  - per-file failures increment `files_errored` and do not abort the run
  - markdown chunker falls back to default chunker
  - stale pruning works
  - non-UTF8 decoding uses charset detection or reports a read error
  - `start_char` / `end_char` and `line_start` / `line_end` are correct
  - unchunked trailing-newline files report correct `end_line`
- `tests/workspace/test_cli.py`
  - `roots list/add/remove` JSON output
  - `index` summary JSON includes `files_errored`, `errors`, `errors_truncated`
  - `search` returns flat JSON results
  - `--path`, `--glob`, `--limit`, and `--human` behavior
  - invalid config/query cases return clean errors, not raw tracebacks

### Required Test Commands

At minimum:

```bash
python -m pytest tests/workspace/ -q
python -m pytest tests/ -q
```

The workspace-specific suite is the focused gate for this feature. The full test
suite must also pass to catch integration regressions in CLI/config wiring.

### Manual CLI Verification

Run the real CLI against a temporary `HERMES_HOME` so the feature is validated
through the same entrypoint an agent will use.

Required checks:

1. `hermes workspace roots list`
2. `hermes workspace roots add <path> --recursive`
3. `hermes workspace roots remove <path>`
4. `hermes workspace index`
5. re-run `hermes workspace index` and verify skip behavior on unchanged files
6. `hermes workspace search "deployment"`
7. `hermes workspace search "hermes-agent"`
8. `hermes workspace search "read_file"`
9. `hermes workspace search "NOT agent"`
10. `hermes workspace search "deployment" --path <prefix>`
11. `hermes workspace search "deployment" --glob "*.md"`
12. `hermes workspace search "deployment" --limit 5`
13. `hermes workspace --human search "deployment"`
14. non-UTF8 text file indexing/search behavior
15. ignore precedence behavior with `.hermesignore`, `.gitignore`, and no file

### Acceptance Criteria

All of the following must be true before merge:

1. No raw traceback is shown to the user for:
   - malformed/free-text queries
   - reserved words in search text
   - invalid workspace config
   - per-file indexing failures
2. Query normalization matches the spec:
   - reserved words are treated as literal text
   - hyphenated/underscored compounds behave as compound queries
   - unicode terms remain searchable
3. Indexing is fault-tolerant:
   - one bad file does not abort the run
   - `files_errored`, `errors`, and `errors_truncated` are populated correctly
4. Ignore handling matches the precedence spec per root:
   - `.hermesignore` overrides `.gitignore`
   - `.gitignore` is used when `.hermesignore` is absent
   - seeded defaults apply when neither file exists
5. `overlap` is actually wired into chunker construction and changing it causes
   a real chunking change on reindex
6. Search result navigation fields are correct:
   - `line_start` / `line_end` are accurate
   - `start_char` / `end_char` are consistent with stored text
7. JSON output remains stable and machine-consumable:
   - index returns summary object
   - search returns flat result array
   - human mode remains opt-in
8. The full pytest suite passes

### Ship Decision

If any P0 item in Hardening fails verification, the feature does not ship.
P1 items are also required before merge for phase 1. P2 items may ship only if
explicitly accepted as follow-up work, but the doc should call that out.

---

## Hardening (Phase 1.1)

Fixes identified during E2E testing and code review. All must land before the
feature ships. Organized by priority.

### P0: Query Normalization — Crashes and Silent Misses

**Files:** `workspace/store.py` (`_build_fts_query`)

**Bugs:**
- Reserved FTS5 keywords (`NOT`, `AND`, `OR`, `NEAR`) in user input crash
  search with `OperationalError`.
- Hyphenated terms (`hermes-agent`) produce zero results because the tokenizer
  joins parts into a non-existent token (`hermesagent`).
- Underscored terms (`read_file`) have the same issue.

**Fix:** Rewrite `_build_fts_query()` per the Query Normalization spec above.
Implementation:

```python
import re

_FTS5_COMPOUND_SEPARATORS = re.compile(r'[-_]')

def _build_fts_query(raw_query: str) -> str:
    tokens = re.findall(r'[^\W_]+', raw_query, re.UNICODE)
    tokens = [t for t in tokens if len(t) >= 2]
    if not tokens:
        return ""

    # Detect compound terms from original input
    words = raw_query.split()
    parts = []
    token_idx = 0
    for word in words:
        sub_tokens = re.findall(r'[^\W_]+', word, re.UNICODE)
        sub_tokens = [t for t in sub_tokens if len(t) >= 2]
        if not sub_tokens:
            continue
        if len(sub_tokens) > 1 and _FTS5_COMPOUND_SEPARATORS.search(word):
            # Compound: AND + phrase boost
            phrase = " ".join(sub_tokens)
            and_clause = " AND ".join(f'"{t}"' for t in sub_tokens)
            parts.append(f'("{phrase}" OR ({and_clause}))')
        else:
            for t in sub_tokens:
                parts.append(f'"{t}"')

    return " OR ".join(parts)
```

### P0: Indexing Fault Tolerance — Per-File Error Isolation

**Files:** `workspace/indexer.py`, `workspace/files.py`, `workspace/types.py`

**Bugs:**
- A file vanishing between discovery and `stat()` raises `FileNotFoundError`
  and aborts the entire index run.
- A markdown chunker crash aborts the entire run (code chunker already has
  fallback, markdown does not).

**Fix:**
1. Wrap the per-file loop body in `index_workspace()` with `try/except Exception`.
2. On failure: increment `files_errored`, append to `errors` list (capped at
   50), log full traceback, continue to next file.
3. In `iter_workspace_files()`: wrap `stat()` calls in try/except, skip vanished
   files with a `log.debug`.
4. Add chunker fallback for markdown path: `markdown → default → error`.

Add to `IndexSummary`:
```python
@dataclass
class IndexError:
    path: str
    stage: str       # "discover" | "read" | "chunk" | "store"
    error_type: str  # Exception class name
    message: str

@dataclass
class IndexSummary:
    files_indexed: int
    files_skipped: int
    files_pruned: int
    files_errored: int
    chunks_created: int
    duration_seconds: float
    errors: list[IndexError]
    errors_truncated: bool
```

### P0: Config Validation — Reject Invalid Values Early

**Files:** `workspace/config.py`

**Bug:** Invalid config values (`chunk_size: 0`, `threshold: -1`) flow through
unchecked and surface as raw tracebacks deep in Chonkie or the indexer.

**Fix:** Add validation in `WorkspaceConfig.from_dict()`:
```python
if ch.chunk_size <= 0:
    raise ValueError(f"knowledgebase.chunking.chunk_size must be > 0, got {ch.chunk_size}")
if ch.overlap < 0 or ch.overlap >= ch.chunk_size:
    raise ValueError(f"knowledgebase.chunking.overlap must be >= 0 and < chunk_size")
# ... etc for threshold, max_file_mb, default_limit
```

### P1: Remove Hardcoded Hidden File Filtering

**Files:** `workspace/files.py`, `workspace/constants.py`

**Bug:** `_is_hidden()` unconditionally skips all dotfiles/dotdirs. This runs
before `.hermesignore`, so negation patterns like `!.github/workflows/ci.yml`
can never re-include a hidden file.

**Fix:**
1. Delete `_is_hidden()` entirely.
2. Implement ignore file precedence per root:
   `.hermesignore` → `.gitignore` → seeded Hermes defaults.
3. Add `_load_ignore_spec(root)` that checks for `.hermesignore` first, then
   `.gitignore`, then falls back to a built-in default pattern set.
4. Seed `.hermesignore` into the configured primary workspace root on init
   (only if the file doesn't exist).

### P1: Encoding Detection — No Lossy Indexing

**Files:** `workspace/indexer.py`, `pyproject.toml`

**Bug:** `errors="replace"` inserts U+FFFD characters, making non-UTF8 content
unsearchable. `café` becomes `caf\ufffd` — neither `café` nor `cafe` matches.

**Fix:**
1. Add `charset-normalizer` to base dependencies in `pyproject.toml`.
2. Replace the file read logic:
   ```python
   def _read_file_text(path: Path) -> str | None:
       raw = path.read_bytes()
       try:
           return raw.decode("utf-8")
       except UnicodeDecodeError:
           pass
       from charset_normalizer import from_bytes
       result = from_bytes(raw).best()
       if result is None or result.encoding is None:
           return None  # skip file, report error
       confidence = result.coherence  # 0.0 - 1.0 (charset_normalizer uses .coherence, not .confidence)
       if confidence < 0.5:
           return None
       return str(result)
   ```
3. Return `None` from `_read_file_text()` when detection fails. Caller reports
   error with `stage="read"`.

### P1: Wire Overlap Into Chunkers

**Files:** `workspace/indexer.py`

**Bug:** `overlap` is in the config and config signature, but never passed to
any Chonkie chunker. Changing `overlap` forces a full reindex with no observable
effect on chunking.

**Fix:** Pass `chunk_overlap=config.overlap` to all three chunker constructors:
```python
self._markdown = RecursiveChunker.from_recipe(
    "markdown", tokenizer="word", chunk_size=ch.chunk_size,
    chunk_overlap=ch.overlap,
)
self._code = CodeChunker(
    tokenizer="word", chunk_size=ch.chunk_size, language="auto",
    chunk_overlap=ch.overlap,
)
self._default = RecursiveChunker(
    tokenizer="word", chunk_size=ch.chunk_size,
    chunk_overlap=ch.overlap,
)
```

### P2: Rename start_byte/end_byte → start_char/end_char

**Files:** `workspace/types.py`, `workspace/store.py`, `workspace/indexer.py`

**Bug:** Chonkie returns character offsets (`start_index`, `end_index` are
Python string positions). For single-chunk files, the code computes
`len(text.encode("utf-8"))` which is a byte count. The field names say "byte"
but the semantics are inconsistent.

**Fix:** Rename everywhere: schema, dataclass fields, SQL queries, indexer
logic. For single-chunk files, use `len(full_text)` (character count) instead
of `len(full_text.encode("utf-8"))`. No schema version bump needed — this is
a pre-ship change.

### P2: Fix end_line Off-by-One

**Files:** `workspace/indexer.py`

**Bug:** `total_lines = full_text.count("\n") + 1` reports one line too many
when the file ends with `\n` (which is standard).

**Fix:** Use `len(full_text.splitlines())` — reports the last line with content.

### P2: Clamp limit to Positive Values

**Files:** `workspace/store.py`, `workspace/search.py`

**Bug:** `limit=-1` is interpreted by SQLite as unlimited. `limit=0` returns
nothing.

**Fix:** In `search()`, clamp: `limit = max(1, limit)` before passing to SQL.

---

## Out of Scope

- File watcher / auto-re-indexing daemon
- Agent tool registration (`workspace(action="search")`)
- Retrieval injection into conversation turns
- Vector/dense search (sqlite-vec, embeddings)
- Plugin system / plugin discovery
- Reranking
- Query enrichment from conversation history
- PDF/DOCX parsing (requires separate extraction → markdown conversion layer)
- Setup wizard

---

## Second Pass (Future)

After this feature ships and is validated:

1. **Base class extraction**: Extract `WorkspaceStore` ABC from `SQLiteFTS5Store`.
   Extract chunker/parser dispatch into overrideable interfaces.
2. **Plugin hooks**: Wire base classes into the existing Hermes plugin system
   so backends can be swapped via config.
3. **Agent tool**: Register `workspace(action="search")` as a callable tool.
4. **Retrieval injection**: Wire workspace search into the conversation turn
   pipeline (cache-safe, turn-scoped, appended to user message).
5. **Vector search**: Add sqlite-vec dense search backend, embedder plugins,
   hybrid RRF fusion.
6. **File watcher**: Background polling daemon for auto-re-indexing.
7. **Document conversion**: PDF/DOCX/PPT → markdown conversion layer (upstream
   of Chonkie chunking).

---

## Lineage

Built on the foundation work from:
- **PR #1324** — original workspace + RAG design spec by @teknium1
- **PR #5840** — modularized plugin pipeline by @teknium1 + @kshitijk4poor
- **spec.md** — consolidated feature spec extracted from both PRs
- Salvaged types and schema patterns from `.worktrees/pr-5840/`

This feature implements a focused subset: the storage and search layer,
validated end-to-end, before layering on the retrieval and agent integration.
