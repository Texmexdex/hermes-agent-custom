"""Workspace data types.

Salvaged from PR #5840's agent/workspace_types.py, trimmed for FTS5-only:
no dense scores, no reranking, no plugin context.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class WorkspaceRoot:
    path: str
    recursive: bool = False


@dataclass(frozen=True)
class FileRecord:
    abs_path: str
    root_path: str
    content_hash: str
    config_signature: str
    size_bytes: int
    modified_at: str
    indexed_at: str
    chunk_count: int = 0


@dataclass(frozen=True)
class ChunkRecord:
    chunk_id: str
    abs_path: str
    chunk_index: int
    content: str
    token_count: int
    start_line: int
    end_line: int
    start_char: int
    end_char: int
    section: str | None = None
    kind: str = "text"


@dataclass(frozen=True)
class SearchResult:
    path: str
    line_start: int
    line_end: int
    section: str | None
    chunk_index: int
    score: float
    tokens: int
    modified: str
    content: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "line_start": self.line_start,
            "line_end": self.line_end,
            "section": self.section,
            "chunk_index": self.chunk_index,
            "score": self.score,
            "tokens": self.tokens,
            "modified": self.modified,
            "content": self.content,
        }


@dataclass(frozen=True)
class IndexError:
    path: str
    stage: str
    error_type: str
    message: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "stage": self.stage,
            "error_type": self.error_type,
            "message": self.message,
        }


@dataclass(frozen=True)
class IndexSummary:
    files_indexed: int
    files_skipped: int
    files_pruned: int
    files_errored: int
    chunks_created: int
    duration_seconds: float
    errors: list[IndexError]
    errors_truncated: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "files_indexed": self.files_indexed,
            "files_skipped": self.files_skipped,
            "files_pruned": self.files_pruned,
            "files_errored": self.files_errored,
            "chunks_created": self.chunks_created,
            "duration_seconds": round(self.duration_seconds, 2),
            "errors": [e.to_dict() for e in self.errors],
            "errors_truncated": self.errors_truncated,
        }
