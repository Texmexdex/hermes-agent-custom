"""File discovery and filtering for workspace indexing.

Iterates workspace roots, applies ignore patterns (via pathspec),
skips binary files and files over the size limit.

Ignore file precedence per root (first match wins):
  1. root/.hermesignore
  2. root/.gitignore
  3. Built-in default patterns
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Iterator

from workspace.constants import (
    BINARY_SUFFIXES,
    DEFAULT_IGNORE_PATTERNS,
    GITIGNORE_NAME,
    HERMESIGNORE_NAME,
)
from workspace.config import WorkspaceConfig
from workspace.types import WorkspaceRoot

log = logging.getLogger(__name__)


def iter_workspace_files(
    config: WorkspaceConfig,
) -> Iterator[tuple[str, Path]]:
    """Yield (root_path, file_path) for every indexable file across all roots."""
    max_bytes = config.knowledgebase.indexing.max_file_mb * 1024 * 1024

    all_roots = [
        WorkspaceRoot(path=str(config.workspace_root), recursive=True),
        *config.knowledgebase.roots,
    ]

    for root_spec in all_roots:
        root = Path(root_spec.path).expanduser().resolve()
        if not root.is_dir():
            log.warning("Workspace root does not exist: %s", root)
            continue

        ignore_spec = _load_ignore_spec(root)

        if root_spec.recursive:
            it = root.rglob("*")
        else:
            it = root.iterdir()

        for p in sorted(it):
            if not p.is_file():
                continue
            if p.suffix.lower() in BINARY_SUFFIXES:
                continue
            try:
                size = p.stat().st_size
            except (FileNotFoundError, OSError):
                log.debug("File vanished during discovery: %s", p)
                continue
            if size > max_bytes:
                log.debug("Skipping oversized file: %s", p)
                continue
            if size == 0:
                continue
            if ignore_spec is not None and _is_ignored(p, root, ignore_spec):
                continue
            yield str(root), p


def seed_hermesignore(workspace_root: Path) -> None:
    """Create .hermesignore in the workspace root if it doesn't exist."""
    ignore_file = workspace_root / HERMESIGNORE_NAME
    if not ignore_file.exists():
        ignore_file.write_text(DEFAULT_IGNORE_PATTERNS, encoding="utf-8")


def _load_ignore_spec(root: Path):
    """Load ignore patterns for a root: .hermesignore → .gitignore → defaults."""
    try:
        import pathspec
    except ImportError:
        log.warning("pathspec not installed — ignore patterns will not be applied")
        return None

    hermesignore = root / HERMESIGNORE_NAME
    if hermesignore.is_file():
        try:
            text = hermesignore.read_text(encoding="utf-8", errors="replace")
            return pathspec.PathSpec.from_lines("gitwildmatch", text.splitlines())
        except Exception:
            log.warning("Failed to parse %s", hermesignore, exc_info=True)

    gitignore = root / GITIGNORE_NAME
    if gitignore.is_file():
        try:
            text = gitignore.read_text(encoding="utf-8", errors="replace")
            return pathspec.PathSpec.from_lines("gitwildmatch", text.splitlines())
        except Exception:
            log.warning("Failed to parse %s", gitignore, exc_info=True)

    return pathspec.PathSpec.from_lines("gitwildmatch", DEFAULT_IGNORE_PATTERNS.splitlines())


def _is_ignored(path: Path, root: Path, spec) -> bool:
    rel = path.relative_to(root).as_posix()
    return spec.match_file(rel)
