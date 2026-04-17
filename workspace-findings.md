# Workspace FTS5 Review Findings

Date: 2026-04-17

Context:
- Reviewed the workspace indexing/search implementation added in commit `228a2319`.
- Validated behavior both through the real CLI entrypoint (`.venv/bin/hermes workspace ...`) and direct runtime checks with `.venv/bin/python`.
- Goal was to find real-world edge cases beyond the happy path.

## Summary

Highest-priority issues:

1. Query normalization is unsafe and incomplete.
   - Reserved FTS keywords can crash search.
   - Hyphenated terms miss obvious results.
2. Invalid config values surface as raw tracebacks in the CLI.
3. Indexing is not fault-tolerant per file.
   - A disappearing file can abort the run.
   - A markdown/default chunker failure can abort the run.

High-value follow-up issues:

1. Hidden files cannot be re-included via `.hermesignore` because hidden filtering runs first.
2. Non-UTF8 text is indexed lossy, causing false negatives for exact searches.
3. `overlap` is included in the config signature but is not wired into any chunker, so it forces reindexing with no observable effect.

Lower-priority cleanup:

1. `start_byte` / `end_byte` are not true byte offsets for chunked Unicode files.
2. Some text-ish files are silently skipped because suffix filtering treats them as binary (`.svg`, `.lock`).

## Confirmed CLI Findings

These were reproduced through the actual CLI path an agent would use: `.venv/bin/hermes workspace ...`.

### 0. `--human` only works before the workspace subcommand

Severity: P1

Reproduction:

```bash
.venv/bin/hermes workspace --human search "foo"
```

works, but:

```bash
.venv/bin/hermes workspace search "foo" --human
```

fails with argparse parsing errors.

Relevant code:
- [hermes_cli/main.py](/Users/sid/main-quests/nous-research/hermes-agent/hermes_cli/main.py:6388)

Notes:
- This was reported in earlier E2E testing and is a real CLI ergonomics issue.
- Parent parser flags currently need to appear before the subcommand.

### 1. Reserved FTS keywords crash search

Severity: P0

Reproduction:

```bash
.venv/bin/hermes workspace search "NOT agent"
```

Observed behavior:
- The command exits with a raw traceback ending in:
  - `sqlite3.OperationalError: fts5: syntax error near "NOT"`

Relevant code:
- [workspace/store.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/store.py:260)
- [workspace/search.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/search.py:26)
- [hermes_cli/workspace_commands.py](/Users/sid/main-quests/nous-research/hermes-agent/hermes_cli/workspace_commands.py:131)

Notes:
- This matches the earlier E2E report.
- The CLI currently does not catch and normalize the error into structured JSON.

### 2. Hyphenated queries miss obvious matches

Severity: P0

Reproduction:

```bash
.venv/bin/hermes workspace search "hermes-agent"
```

Observed behavior:
- Returns `[]` even when indexed content includes `hermes-agent`.

Relevant code:
- [workspace/store.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/store.py:260)

Notes:
- This matches the earlier E2E report.
- Root cause is query tokenization not matching how FTS tokenizes hyphenated content.

### 3. Invalid chunking config crashes `workspace index`

Severity: P0

Reproduction:

```yaml
knowledgebase:
  chunking:
    chunk_size: 0
    threshold: 0
```

Then:

```bash
.venv/bin/hermes workspace index
```

Observed behavior:
- Raw traceback ending in:
  - `ValueError: chunk_size must be greater than 0`

Relevant code:
- [workspace/config.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/config.py:47)
- [workspace/indexer.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/indexer.py:94)
- [hermes_cli/workspace_commands.py](/Users/sid/main-quests/nous-research/hermes-agent/hermes_cli/workspace_commands.py:74)

Notes:
- Config values flow through without validation.
- The CLI should return a clean error instead of a traceback.

### 4. Hidden files cannot be re-included via `.hermesignore`

Severity: P1

Reproduction:
- Put a file under `.github/workflows/ci.yml`.
- Add `!/.github/workflows/ci.yml` to `.hermesignore`.
- Run `hermes workspace index` and `hermes workspace search hidden`.

Observed behavior:
- The file is never indexed.
- Search returns `[]`.

Relevant code:
- [workspace/files.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/files.py:51)
- [workspace/files.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/files.py:60)

Notes:
- Hidden filtering runs before `.hermesignore` matching.
- This makes gitignore-style negation ineffective for dotfiles and dot-directories.

### 5. Non-UTF8 text is indexed lossy, causing false negatives

Severity: P1

Reproduction:
- Index a Latin-1 file containing `café deployer`.

Observed behavior:
- `hermes workspace search deployer` returns the file.
- `hermes workspace search café` returns `[]`.
- `hermes workspace search cafe` returns `[]`.
- Indexed content is stored as `caf\ufffd deployer`.

Relevant code:
- [workspace/indexer.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/indexer.py:82)

Notes:
- The current `errors="replace"` policy is resilient, but it silently destroys searchable content.

### 6. `overlap` forces reindexing but does not change chunking behavior

Severity: P1

Reproduction:
- Index a large markdown file with `overlap: 0`.
- Reindex the same file with `overlap: 200`.

Observed behavior:
- The file reindexes because the config signature changes.
- `chunks_created` stayed the same in my CLI run.
- Search results were byte-for-byte identical across runs.

Relevant code:
- [workspace/indexer.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/indexer.py:146)
- [workspace/indexer.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/indexer.py:158)
- [workspace/indexer.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/indexer.py:170)
- [workspace/indexer.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/indexer.py:299)

Notes:
- `overlap` is part of the signature but is not passed into any chunker constructor.

### 7. `.svg` and `.lock` are silently skipped as binary

Severity: P2

Reproduction:
- Create `icon.svg`, `uv.lock`, and `readme.txt`.
- Run `hermes workspace index`.
- Search for terms present in each file.

Observed behavior:
- `readme.txt` is indexed.
- `icon.svg` and `uv.lock` are not indexed.

Relevant code:
- [workspace/constants.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/constants.py:11)
- [workspace/files.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/files.py:53)

Notes:
- This may be intentional, but it is worth revisiting because both file types are often useful search targets.

### 8. `limit=-1` yields unlimited results

Severity: P2

Reproduction:

```bash
.venv/bin/hermes workspace search "foo" --limit -1
```

Observed behavior:
- SQLite treats `LIMIT -1` as unlimited, so the command can return far more results than expected.

Relevant code:
- [workspace/store.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/store.py:222)
- [workspace/config.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/config.py:66)

Notes:
- This also applies to invalid negative `knowledgebase.search.default_limit` values in config.
- It should be clamped or validated.

### 9. Overlapping roots produce duplicate logical results

Severity: P2

Observed behavior:
- The same content can appear multiple times in search results when indexed via multiple roots.
- This is expected under the current design and was explicitly allowed in the feature notes.

Relevant code:
- [workspace/files.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/files.py:30)
- [workspace/indexer.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/indexer.py:65)

Notes:
- This is not necessarily a bug for phase 1.
- It is still worth documenting because it will surprise users if they index overlapping roots.

## Confirmed Direct Runtime Findings

These were reproduced with `.venv/bin/python` against the implementation directly.

### 10. A disappearing file can abort the whole index run

Severity: P0

Observed behavior:
- If a file vanishes between discovery and the size check, `iter_workspace_files()` raises `FileNotFoundError`.

Relevant code:
- [workspace/files.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/files.py:48)
- [workspace/files.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/files.py:55)

Notes:
- Real-world candidates: generated files, editor temp files, concurrent cleanup, build outputs.
- This should be handled per file and downgraded to a skip.

### 11. A markdown/default chunker failure aborts the whole run

Severity: P0

Observed behavior:
- If the markdown chunker throws for one file, `index_workspace()` aborts.

Relevant code:
- [workspace/indexer.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/indexer.py:94)
- [workspace/indexer.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/indexer.py:191)

Notes:
- Only the code path has a fallback to the default chunker.
- Markdown and generic text paths currently do not isolate failures per file.

### 12. `start_byte` / `end_byte` are inconsistent for Unicode chunked files

Severity: P2

Observed behavior:
- For chunked Unicode files, the stored offsets correspond to character offsets returned by Chonkie, not UTF-8 byte offsets.
- For small single-chunk files, `end_byte` is computed using `len(full_text.encode("utf-8"))`.
- This means the schema name says “byte offsets,” but the meaning changes depending on the code path.

Relevant code:
- [workspace/types.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/types.py:32)
- [workspace/indexer.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/indexer.py:207)
- [workspace/indexer.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/indexer.py:233)

Notes:
- This is mostly a cleanup / correctness issue today.
- It becomes more important if future code relies on these fields for file slicing or highlighting.

## Correction To An Earlier Suspicion

I originally suspected Unicode content might also break line numbers.

That appears to be incorrect.

What I validated:
- Chonkie 1.6.2 is returning character offsets.
- The line mapping logic also uses character offsets.
- So line numbers themselves appear consistent.

The real issue is narrower:
- The `start_byte` / `end_byte` field names do not match the actual semantics for chunked Unicode files.

## Additional Implementation Notes

### 13. Single-chunk files can report `end_line` one line too high when the file ends with `\n`

Severity: P2

Observed behavior:
- For unchunked files, `end_line` is computed with `full_text.count("\\n") + 1`.
- Files that end with a trailing newline can therefore report one extra line relative to how many editors display content.

Relevant code:
- [workspace/indexer.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/indexer.py:208)

Notes:
- This came from earlier E2E testing.
- It is cosmetic but user-visible in search results.

### 14. Symlinked roots are canonicalized to the resolved real path

Severity: Note

Observed behavior:
- Paths are normalized with `resolve()`.
- In a quick runtime check, the same file reached through a real root and a symlinked root ended up indexed once under the resolved real path.

Relevant code:
- [workspace/files.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/files.py:36)
- [workspace/indexer.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/indexer.py:65)

Notes:
- This is not currently a bug.
- It is useful to know because search results will point to the resolved path, not necessarily the symlink path the user configured.

## Recommended Fix Order

### Blockers before broader rollout

1. Fix query normalization in [workspace/store.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/store.py:260).
2. Add config validation and CLI-safe error handling in [workspace/config.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/config.py:47) and [hermes_cli/workspace_commands.py](/Users/sid/main-quests/nous-research/hermes-agent/hermes_cli/workspace_commands.py:74).
3. Make indexing fault-tolerant per file in [workspace/files.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/files.py:20) and [workspace/indexer.py](/Users/sid/main-quests/nous-research/hermes-agent/workspace/indexer.py:42).

### Strong follow-up candidates

1. Decide and document the hidden-file policy.
2. Revisit non-UTF8 decode strategy.
3. Either wire `overlap` through or remove it from the config signature.

### Cleanup / later

1. Revisit the binary suffix set.
2. Rename or fix the offset fields.

## Suggested Tests

There does not appear to be an existing workspace test suite yet under `tests/workspace/`.

Suggested first additions:

1. `tests/workspace/test_cli.py::test_search_reserved_words_does_not_traceback`
2. `tests/workspace/test_cli.py::test_search_hyphenated_term_matches_hyphenated_content`
3. `tests/workspace/test_cli.py::test_index_invalid_chunk_size_returns_clean_error`
4. `tests/workspace/test_files.py::test_hidden_file_negation_behavior_is_explicit`
5. `tests/workspace/test_files.py::test_deleted_file_during_discovery_is_skipped`
6. `tests/workspace/test_indexer.py::test_markdown_chunker_failure_skips_file_not_run`
7. `tests/workspace/test_cli.py::test_latin1_file_search_behavior`
8. `tests/workspace/test_indexer.py::test_overlap_change_either_changes_chunks_or_does_not_reindex`
9. `tests/workspace/test_files.py::test_svg_and_lock_suffix_policy`
10. `tests/workspace/test_indexer.py::test_unicode_chunk_offsets_are_consistent`
