"""Workspace indexing and FTS5 search.

Public API:
    index_workspace(config) -> IndexSummary
    search_workspace(query, config, ...) -> list[SearchResult]
    load_workspace_config() -> WorkspaceConfig
    ensure_workspace_dirs(config) -> None
"""

from workspace.config import WorkspaceConfig, load_workspace_config
from workspace.indexer import ensure_workspace_dirs, index_workspace
from workspace.search import search_workspace
from workspace.types import IndexError, IndexSummary, SearchResult

__all__ = [
    "WorkspaceConfig",
    "load_workspace_config",
    "index_workspace",
    "search_workspace",
    "ensure_workspace_dirs",
    "IndexError",
    "IndexSummary",
    "SearchResult",
]
