# Decisions That Diverge from PR #5840

Each entry: what the PR does → what we decided instead, and why.

---

### Chunking Library

**PR**: Custom `BuiltinStructuralChunker` — pure Python, regex-based heading/def/paragraph splits, character-window with overlap. Zero dependencies.

**We**: Chonkie library — `RecursiveChunker.from_recipe("markdown")` for markdown (with MarkdownChef pre-processing), `CodeChunker` (tree-sitter AST) for code, `RecursiveChunker` for everything else.

**Why**: Tree-sitter gives real AST-aware code splits. MarkdownChef extracts structured metadata (tables, code blocks). Chonkie is actively maintained and handles edge cases we'd otherwise have to build ourselves. Trade: adds external dependency + tree-sitter + Magika.

---

### Tokenizer / Unit of Measurement

**PR**: Character-based. `chunk_size * 4 = target_chars`. Token estimates via `len(text) // 4`.

**We**: Word-based via Chonkie's built-in word tokenizer. `chunk_size=512` = 512 words. Same tokenizer for the 16K threshold check.

**Why**: Words are a more natural and predictable unit than characters/4. Consistent with how users think about document size.

---

### Small File Threshold

**PR**: No threshold. Every file goes through the chunker (naturally produces one chunk if small enough).

**We**: Explicit 16K-word threshold. Files under 16K words → single FTS5 row, no chunking. Files over → chunked.

**Why**: Avoids chunking overhead for the vast majority of files. Simpler index for small documents. Chunking only activates when it actually adds search granularity.

---

### FTS5 Tokenizer (Stemming)

**PR**: Default `unicode61` — no stemming. Exact token matching only.

**We**: `tokenize='porter unicode61'` — porter stemmer enabled.

**Why**: `deploying` matches `deployment`. Better recall for English knowledge bases. Standard for document search.

---

### Schema: Line Numbers

**PR**: No line numbers anywhere. No byte offsets. Chunks store `content`, `token_estimate`, `embedding`.

**We**: Chunks store `start_line`, `end_line`, `start_byte`, `end_byte`, `section`, `kind`.

**Why**: The agent can go straight to `read_file(path, start=142, end=198)` instead of reading the whole file. Line numbers are computed from Chonkie's byte offsets at index time, recomputed on re-index.

---

### Schema: Primary Key

**PR**: `files.rel_path` (relative path) is the primary key.

**We**: `files.abs_path` (absolute path) is the primary key.

**Why**: Absolute paths are unambiguous across multiple roots. Search results return absolute paths directly usable in `read_file`. No need to resolve relative → absolute at query time.

---

### Schema: Dense Search Columns

**PR**: `chunks.embedding TEXT NOT NULL` column, optional `chunks_vec` virtual table for sqlite-vec ANN search.

**We**: No embedding column, no vec table. FTS5 only.

**Why**: Out of scope for phase 1. Vector search is second pass. Don't store empty/unused columns.

---

### Schema: FTS5 Triggers

**PR**: Manual `INSERT INTO chunks_fts` calls in `insert_chunks()`.

**We**: `AFTER INSERT`/`AFTER DELETE` triggers keep FTS5 in sync automatically.

**Why**: Can't forget to update FTS5. CASCADE deletes on files automatically propagate through triggers to FTS5.

---

### Schema: FTS5 Section Column

**PR**: `chunks_fts` indexes only `chunk_id, rel_path, content`. No section.

**We**: `chunks_fts` indexes `chunk_id UNINDEXED, abs_path UNINDEXED, content, section`.

**Why**: Section headings become searchable. A query like `"rollback procedures"` matches the section title even if the chunk content doesn't contain those exact words.

---

### CLI Output Format

**PR**: Rich console output only. Human-first. No JSON mode.

**We**: JSON by default. `--human`/`--pretty` flag for Rich output.

**Why**: The agent is the primary consumer. JSON is trivially parseable by an LLM — it's literally training data. Grep-style or Rich output means the agent wastes reasoning tokens on string parsing. The agent should be able to call the CLI directly.

---

### Database Location

**PR**: `~/.hermes/knowledgebase/indexes/workspace.sqlite` — separate sibling directory.

**We**: `~/.hermes/workspace/.index/workspace.sqlite` — hidden dir inside workspace.

**Why**: Everything workspace-related in one tree. Easier to find, reason about, and delete.

---

### Package Layout

**PR**: Full plugin architecture — `agent/workspace.py` (monolithic orchestrator) + `agent/workspace_types.py` + `agent/workspace_contracts.py` + `agent/workspace_plugin_manager.py` + `plugins/workspace/{parsers,chunkers,embedders,index_stores,rerankers,retrievers}/`.

**We**: Flat `workspace/` package at repo root — `constants.py`, `types.py`, `config.py`, `store.py`, `indexer.py`, `search.py`, `files.py`. No plugin system.

**Why**: Plugin system is second pass. First pass gets the core working with clean, direct code. Base class extraction happens after we have a working concrete implementation to extract from.

---

### Dependencies

**PR**: No new core deps. Optional: `pymupdf`, `python-docx`, `sentence-transformers`, `torch`, `sqlite-vec`.

**We**: Required: `pathspec`. Optional `[workspace]`: `chonkie`, `chonkie[code]` (tree-sitter + Magika).

**Why**: Different chunking strategy (Chonkie vs built-in), different ignore parsing (pathspec vs fnmatch). No embeddings/vector deps needed for FTS5-only.

---

### .hermesignore Parsing

**PR**: `fnmatch.fnmatch` — simple glob matching. No negation, no `**` recursive globs, no directory-only rules.

**We**: `pathspec` library — full gitignore semantics including negation (`!pattern`), `**` recursive globs, directory-only rules.

**Why**: Users already know gitignore syntax. Partial gitignore support is a footgun — patterns that look right but behave wrong.

---

### Content Hash Target

**PR**: SHA-256 of parsed text (after `parser.parse()` → `document.text`).

**We**: SHA-256 of raw file bytes.

**Why**: Simpler. Doesn't require parsing to check if re-indexing is needed. If the bytes didn't change, the file didn't change.

---

### Search Result Shape

**PR**: `WorkspaceHit` — `relative_path`, `content`, `metadata` dict, four separate scores (`sparse_score`, `dense_score`, `fusion_score`, `rerank_score`). No line numbers, no section, no token count, no modified time.

**We**: `SearchResult` — `abs_path`, `content`, `line_start`, `line_end`, `section`, `chunk_index`, `score` (single BM25), `tokens`, `modified`. Flat JSON, no wrapper objects.

**Why**: Agent-first. Absolute path + line numbers = the agent can immediately call `read_file(path, start, end)`. Single score since there's only one retrieval method (FTS5). Modified time helps the agent judge freshness.

---

### Root Deduplication

**PR**: Exact duplicate root paths are silently deduplicated via `seen_paths` set. Subdirectory overlap still double-indexes.

**We**: No deduplication. Duplicates allowed. User's problem.

**Why**: Simpler. The overlap case (root A contains root B) is the one that matters, and the PR doesn't handle it either. Don't pretend to solve a problem you're only half-solving.

---

### Scope

**PR**: Full pipeline — parsers, chunkers, embedders, rerankers, retrievers, index stores, plugin manager, file watcher, retrieval injection, agent tool, CLI commands, context injection into conversation turns.

**We**: FTS5 indexing + search only. CLI roots/index/search. Python API. No watcher, no agent tool, no retrieval injection, no embeddings, no reranking, no plugin system.

**Why**: Get the foundation right first. Validate search quality and API ergonomics before layering on the full retrieval pipeline.
