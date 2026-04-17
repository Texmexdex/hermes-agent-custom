"""Workspace configuration loading.

Builds WorkspaceConfig and KnowledgebaseConfig from the main hermes
config.yaml.  Defaults come from workspace.constants so that
hermes_cli/config.py can also import them without circular deps.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from workspace.constants import (
    KNOWLEDGEBASE_CONFIG_DEFAULTS,
    WORKSPACE_CONFIG_DEFAULTS,
    get_workspace_root,
)
from workspace.types import WorkspaceRoot


@dataclass(frozen=True)
class ChunkingConfig:
    chunk_size: int = 512
    overlap: int = 80
    threshold: int = 16_000


@dataclass(frozen=True)
class IndexingConfig:
    max_file_mb: int = 10


@dataclass(frozen=True)
class SearchConfig:
    default_limit: int = 20


@dataclass(frozen=True)
class KnowledgebaseConfig:
    roots: list[WorkspaceRoot] = field(default_factory=list)
    chunking: ChunkingConfig = field(default_factory=ChunkingConfig)
    indexing: IndexingConfig = field(default_factory=IndexingConfig)
    search: SearchConfig = field(default_factory=SearchConfig)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> KnowledgebaseConfig:
        merged = _deep_merge(copy.deepcopy(KNOWLEDGEBASE_CONFIG_DEFAULTS), d)
        roots = [
            WorkspaceRoot(path=r["path"], recursive=r.get("recursive", False))
            for r in merged.get("roots", [])
            if isinstance(r, dict) and "path" in r
        ]
        ch = merged.get("chunking", {})
        ix = merged.get("indexing", {})
        sr = merged.get("search", {})

        chunk_size = ch.get("chunk_size", 512)
        overlap = ch.get("overlap", 80)
        threshold = ch.get("threshold", 16_000)
        max_file_mb = ix.get("max_file_mb", 10)
        default_limit = sr.get("default_limit", 20)

        if chunk_size <= 0:
            raise ValueError(f"knowledgebase.chunking.chunk_size must be > 0, got {chunk_size}")
        if overlap < 0 or overlap >= chunk_size:
            raise ValueError(
                f"knowledgebase.chunking.overlap must be >= 0 and < chunk_size ({chunk_size}), got {overlap}"
            )
        if threshold < 0:
            raise ValueError(f"knowledgebase.chunking.threshold must be >= 0, got {threshold}")
        if max_file_mb <= 0:
            raise ValueError(f"knowledgebase.indexing.max_file_mb must be > 0, got {max_file_mb}")
        if default_limit < 1:
            raise ValueError(f"knowledgebase.search.default_limit must be >= 1, got {default_limit}")

        return cls(
            roots=roots,
            chunking=ChunkingConfig(
                chunk_size=chunk_size,
                overlap=overlap,
                threshold=threshold,
            ),
            indexing=IndexingConfig(max_file_mb=max_file_mb),
            search=SearchConfig(default_limit=default_limit),
        )


@dataclass(frozen=True)
class WorkspaceConfig:
    enabled: bool = True
    workspace_root: Path = field(default_factory=lambda: Path.home() / ".hermes" / "workspace")
    knowledgebase: KnowledgebaseConfig = field(default_factory=KnowledgebaseConfig)

    @classmethod
    def from_dict(cls, raw: dict[str, Any], hermes_home: Path) -> WorkspaceConfig:
        ws = _deep_merge(copy.deepcopy(WORKSPACE_CONFIG_DEFAULTS), raw.get("workspace", {}))
        kb = raw.get("knowledgebase", {})
        return cls(
            enabled=ws.get("enabled", True),
            workspace_root=get_workspace_root(hermes_home, ws.get("path", "")),
            knowledgebase=KnowledgebaseConfig.from_dict(kb),
        )


def load_workspace_config() -> WorkspaceConfig:
    from hermes_constants import get_config_path, get_hermes_home

    config_path = get_config_path()
    if not config_path.exists():
        return WorkspaceConfig(workspace_root=get_workspace_root(get_hermes_home()))

    import yaml
    with open(config_path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    return WorkspaceConfig.from_dict(raw, get_hermes_home())


def _deep_merge(base: dict, override: dict) -> dict:
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            base[k] = _deep_merge(base[k], v)
        else:
            base[k] = v
    return base
