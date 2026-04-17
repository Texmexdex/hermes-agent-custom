"""Workspace indexing pipeline.

Discovers files → checks content hash + config signature → dispatches to
appropriate Chonkie chunker → computes line numbers → stores in SQLite FTS5.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from workspace.config import WorkspaceConfig
from workspace.constants import CODE_SUFFIXES, MARKDOWN_SUFFIXES, WORKSPACE_SUBDIRS, get_index_dir
from workspace.files import iter_workspace_files, seed_hermesignore
from workspace.store import SQLiteFTS5Store
from workspace.types import ChunkRecord, FileRecord, IndexError, IndexSummary

log = logging.getLogger(__name__)

ProgressCallback = Callable[[int, int, str], None]

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)


def _require_chonkie() -> None:
    try:
        import chonkie  # noqa: F401
    except ImportError:
        raise RuntimeError(
            "Chonkie is required for workspace indexing. "
            "Install it with: pip install hermes-agent[workspace]"
        )


_MAX_ERRORS = 50


def index_workspace(
    config: WorkspaceConfig,
    *,
    progress: ProgressCallback | None = None,
) -> IndexSummary:
    _require_chonkie()

    start = time.monotonic()
    ensure_workspace_dirs(config)
    config_sig = _config_signature(config)

    files_indexed = 0
    files_skipped = 0
    files_errored = 0
    chunks_created = 0
    errors: list[IndexError] = []

    all_files = list(iter_workspace_files(config))
    total = len(all_files)
    disk_paths: set[str] = set()

    chunkers = _ChunkerCache(config)

    with SQLiteFTS5Store(config.workspace_root) as store:
        for i, (root_path, file_path) in enumerate(all_files):
            abs_path = str(file_path.resolve())
            disk_paths.add(abs_path)

            if progress:
                progress(i + 1, total, abs_path)

            try:
                content_hash = _file_hash(file_path)
                existing = store.get_file_record(abs_path)
                if (
                    existing
                    and existing.content_hash == content_hash
                    and existing.config_signature == config_sig
                ):
                    files_skipped += 1
                    continue

                text = _read_file_text(file_path)
                if text is None:
                    files_errored += 1
                    _append_error(errors, IndexError(
                        path=abs_path, stage="read",
                        error_type="EncodingError",
                        message="Could not decode file with sufficient confidence",
                    ))
                    continue

                if not text.strip():
                    files_skipped += 1
                    continue

                store.delete_chunks_for_file(abs_path)

                chunks = _chunk_file(file_path, text, config, chunkers)
                chunk_records = _to_chunk_records(abs_path, text, chunks, file_path.suffix.lower())

                stat = file_path.stat()
                record = FileRecord(
                    abs_path=abs_path,
                    root_path=root_path,
                    content_hash=content_hash,
                    config_signature=config_sig,
                    size_bytes=stat.st_size,
                    modified_at=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                    indexed_at=datetime.now(tz=timezone.utc).isoformat(),
                    chunk_count=len(chunk_records),
                )
                store.upsert_file(record)
                if chunk_records:
                    store.insert_chunks(chunk_records)
                store.commit()

                files_indexed += 1
                chunks_created += len(chunk_records)

            except Exception as exc:
                files_errored += 1
                stage = "discover" if isinstance(exc, FileNotFoundError) else "store"
                _append_error(errors, IndexError(
                    path=abs_path, stage=stage,
                    error_type=type(exc).__name__,
                    message=str(exc),
                ))
                log.warning("Failed to index %s: %s", abs_path, exc, exc_info=True)
                continue

        pruned = _prune_stale(store, disk_paths)
        store.commit()

    elapsed = time.monotonic() - start
    return IndexSummary(
        files_indexed=files_indexed,
        files_skipped=files_skipped,
        files_pruned=pruned,
        files_errored=files_errored,
        chunks_created=chunks_created,
        duration_seconds=elapsed,
        errors=errors,
        errors_truncated=files_errored > _MAX_ERRORS,
    )


def _append_error(errors: list[IndexError], error: IndexError) -> None:
    if len(errors) < _MAX_ERRORS:
        errors.append(error)


def _read_file_text(path: Path) -> str | None:
    raw = path.read_bytes()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    try:
        from charset_normalizer import from_bytes
        result = from_bytes(raw).best()
        if result is None or result.encoding is None:
            return None
        if result.coherence < 0.5:
            return None
        return str(result)
    except ImportError:
        log.debug("charset-normalizer not installed, skipping non-UTF8 file: %s", path)
        return None


def ensure_workspace_dirs(config: WorkspaceConfig) -> None:
    root = config.workspace_root
    root.mkdir(parents=True, exist_ok=True)
    for sub in WORKSPACE_SUBDIRS:
        (root / sub).mkdir(exist_ok=True)
    get_index_dir(root).mkdir(parents=True, exist_ok=True)
    seed_hermesignore(root)


class _ChunkerCache:
    """Lazy-init cache for Chonkie chunkers — created once per index run."""

    def __init__(self, config: WorkspaceConfig) -> None:
        self._config = config
        self._markdown: Any = None
        self._code: Any = None
        self._default: Any = None

    @property
    def markdown(self):
        if self._markdown is None:
            from chonkie import RecursiveChunker
            ch = self._config.knowledgebase.chunking
            self._markdown = RecursiveChunker.from_recipe(
                "markdown",
                tokenizer="word",
                chunk_size=ch.chunk_size,
                chunk_overlap=ch.overlap,
            )
        return self._markdown

    @property
    def code(self):
        if self._code is None:
            from chonkie import CodeChunker
            ch = self._config.knowledgebase.chunking
            self._code = CodeChunker(
                tokenizer="word",
                chunk_size=ch.chunk_size,
                chunk_overlap=ch.overlap,
                language="auto",
            )
        return self._code

    @property
    def default(self):
        if self._default is None:
            from chonkie import RecursiveChunker
            ch = self._config.knowledgebase.chunking
            self._default = RecursiveChunker(
                tokenizer="word",
                chunk_size=ch.chunk_size,
                chunk_overlap=ch.overlap,
            )
        return self._default


def _chunk_file(
    path: Path, text: str, config: WorkspaceConfig, chunkers: _ChunkerCache
) -> list[Any]:
    threshold = config.knowledgebase.chunking.threshold
    word_count = len(text.split())

    if word_count <= threshold:
        return []

    suffix = path.suffix.lower()
    if suffix in MARKDOWN_SUFFIXES:
        try:
            return chunkers.markdown(text)
        except Exception:
            log.debug("Markdown chunker failed for %s, falling back to default", path)
            return chunkers.default(text)
    elif suffix in CODE_SUFFIXES:
        try:
            return chunkers.code(text)
        except Exception:
            log.debug("CodeChunker failed for %s, falling back to default", path)
            return chunkers.default(text)
    else:
        return chunkers.default(text)


def _to_chunk_records(
    abs_path: str, full_text: str, chunks: list[Any], suffix: str,
) -> list[ChunkRecord]:
    if not chunks:
        total_lines = len(full_text.splitlines())
        word_count = len(full_text.split())
        section = _extract_first_heading(full_text) if suffix in MARKDOWN_SUFFIXES else None
        kind = _kind_from_suffix(suffix)
        return [
            ChunkRecord(
                chunk_id=_make_id(),
                abs_path=abs_path,
                chunk_index=0,
                content=full_text,
                token_count=word_count,
                start_line=1,
                end_line=total_lines,
                start_char=0,
                end_char=len(full_text),
                section=section,
                kind=kind,
            )
        ]

    line_offsets = _build_line_offsets(full_text)
    kind = _kind_from_suffix(suffix)
    records = []

    for i, chunk in enumerate(chunks):
        start_char = chunk.start_index
        end_char = chunk.end_index
        start_line = _offset_to_line(line_offsets, start_char)
        end_line = _offset_to_line(line_offsets, max(0, end_char - 1))
        section = _extract_first_heading(chunk.text) if suffix in MARKDOWN_SUFFIXES else None

        records.append(
            ChunkRecord(
                chunk_id=_make_id(),
                abs_path=abs_path,
                chunk_index=i,
                content=chunk.text,
                token_count=chunk.token_count,
                start_line=start_line,
                end_line=end_line,
                start_char=start_char,
                end_char=end_char,
                section=section,
                kind=kind,
            )
        )
    return records


def _build_line_offsets(text: str) -> list[int]:
    """Build a list where offsets[i] is the char offset of line i+1."""
    offsets = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            offsets.append(i + 1)
    return offsets


def _offset_to_line(offsets: list[int], char_offset: int) -> int:
    """Convert a character offset to a 1-based line number."""
    lo, hi = 0, len(offsets) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if offsets[mid] <= char_offset:
            lo = mid
        else:
            hi = mid - 1
    return lo + 1


def _extract_first_heading(text: str) -> str | None:
    m = _HEADING_RE.search(text)
    return m.group(0).strip() if m else None


def _kind_from_suffix(suffix: str) -> str:
    if suffix in MARKDOWN_SUFFIXES:
        return "markdown"
    if suffix in CODE_SUFFIXES:
        return "code"
    return "text"


def _file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def _config_signature(config: WorkspaceConfig) -> str:
    ch = config.knowledgebase.chunking
    blob = json.dumps({
        "chunk_size": ch.chunk_size,
        "overlap": ch.overlap,
        "threshold": ch.threshold,
    }, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def _make_id() -> str:
    return f"chnk_{uuid.uuid4().hex[:12]}"


def _prune_stale(store: SQLiteFTS5Store, disk_paths: set[str]) -> int:
    indexed = store.all_indexed_paths()
    stale = indexed - disk_paths
    for path in stale:
        store.delete_file(path)
    return len(stale)
