"""CLI commands for workspace management.

hermes workspace roots list/add/remove
hermes workspace index
hermes workspace search <query> [--path] [--glob] [--limit]

All commands output JSON by default (agent-first). Use --human for Rich output.
"""

from __future__ import annotations

import json
import sys
from argparse import Namespace
from pathlib import Path
from typing import Any


def workspace_command(args: Namespace) -> None:
    action = getattr(args, "workspace_action", None)
    if action is None:
        print(json.dumps({"error": "No workspace subcommand. Use: roots, index, search"}))
        sys.exit(1)

    human = getattr(args, "human", False)

    if action == "roots":
        _handle_roots(args, human)
    elif action == "index":
        _handle_index(args, human)
    elif action == "search":
        _handle_search(args, human)
    else:
        print(json.dumps({"error": f"Unknown workspace action: {action}"}))
        sys.exit(1)


def _handle_roots(args: Namespace, human: bool) -> None:
    roots_action = getattr(args, "roots_action", "list")

    from workspace.config import load_workspace_config

    if roots_action == "list":
        config = load_workspace_config()
        roots = [
            {"path": r.path, "recursive": r.recursive}
            for r in config.knowledgebase.roots
        ]
        if human:
            _print_human_roots(roots)
        else:
            print(json.dumps(roots, indent=2))

    elif roots_action == "add":
        path = str(Path(args.path).expanduser().resolve())
        recursive = getattr(args, "recursive", False)
        _add_root(path, recursive)
        result = {"added": {"path": path, "recursive": recursive}}
        if human:
            print(f"Added workspace root: {path} (recursive={recursive})")
        else:
            print(json.dumps(result, indent=2))

    elif roots_action == "remove":
        path = str(Path(args.path).expanduser().resolve())
        _remove_root(path)
        result = {"removed": path}
        if human:
            print(f"Removed workspace root: {path}")
        else:
            print(json.dumps(result, indent=2))


def _handle_index(args: Namespace, human: bool) -> None:
    from workspace.config import load_workspace_config
    from workspace.indexer import index_workspace

    config = load_workspace_config()

    if not config.enabled:
        _error("Workspace is disabled (workspace.enabled = false)")
        return

    progress_fn = None
    if human:
        try:
            from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, MofNCompleteColumn
            progress_ctx = Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                BarColumn(),
                MofNCompleteColumn(),
                transient=True,
            )
            progress_ctx.start()
            task_id = progress_ctx.add_task("Indexing...", total=None)

            def _rich_progress(current: int, total: int, path: str) -> None:
                progress_ctx.update(task_id, total=total, completed=current,
                                    description=f"[{current}/{total}] {Path(path).name}")

            progress_fn = _rich_progress
        except ImportError:
            def _simple_progress(current: int, total: int, path: str) -> None:
                print(f"  [{current}/{total}] {Path(path).name}", file=sys.stderr)
            progress_fn = _simple_progress
    else:
        def _stderr_progress(current: int, total: int, path: str) -> None:
            print(f"Indexing [{current}/{total}] {Path(path).name}", file=sys.stderr)
        progress_fn = _stderr_progress

    try:
        summary = index_workspace(config, progress=progress_fn)
    finally:
        if human:
            try:
                progress_ctx.stop()  # type: ignore[possibly-undefined]
            except Exception:
                pass

    if human:
        print(f"\nIndexed {summary.files_indexed} files "
              f"({summary.chunks_created} chunks), "
              f"skipped {summary.files_skipped}, "
              f"errored {summary.files_errored}, "
              f"pruned {summary.files_pruned} stale. "
              f"Took {summary.duration_seconds:.1f}s.")
        if summary.errors:
            print("\nErrors:")
            for err in summary.errors:
                print(f"  [{err.stage}] {err.path}: {err.message}")
            if summary.errors_truncated:
                print(f"  ... and {summary.files_errored - len(summary.errors)} more")
    else:
        print(json.dumps(summary.to_dict(), indent=2))


def _handle_search(args: Namespace, human: bool) -> None:
    from workspace.config import load_workspace_config
    from workspace.search import search_workspace

    config = load_workspace_config()
    query = args.query
    limit = getattr(args, "limit", None)
    raw_path = getattr(args, "path", None)
    path_prefix = str(Path(raw_path).resolve()) if raw_path else None
    file_glob = getattr(args, "glob", None)

    results = search_workspace(
        query, config, limit=limit, path_prefix=path_prefix, file_glob=file_glob,
    )

    if human:
        _print_human_results(results)
    else:
        print(json.dumps([r.to_dict() for r in results], indent=2))


def _add_root(path: str, recursive: bool) -> None:
    from hermes_cli.config import load_config, save_config

    config = load_config()
    kb = config.setdefault("knowledgebase", {})
    roots: list[dict[str, Any]] = kb.setdefault("roots", [])

    for r in roots:
        if r.get("path") == path:
            r["recursive"] = recursive
            save_config(config)
            return

    roots.append({"path": path, "recursive": recursive})
    save_config(config)


def _remove_root(path: str) -> None:
    from hermes_cli.config import load_config, save_config

    config = load_config()
    kb = config.get("knowledgebase", {})
    roots: list[dict[str, Any]] = kb.get("roots", [])
    kb["roots"] = [r for r in roots if r.get("path") != path]
    save_config(config)


def _print_human_roots(roots: list[dict[str, Any]]) -> None:
    if not roots:
        print("No workspace roots configured.")
        return
    for r in roots:
        flag = " (recursive)" if r.get("recursive") else ""
        print(f"  {r['path']}{flag}")


def _print_human_results(results: list) -> None:
    if not results:
        print("No results found.")
        return
    for r in results:
        section = f"  {r.section}" if r.section else ""
        print(f"\n{r.path}:{r.line_start}-{r.line_end} (score: {r.score:.1f}){section}")
        snippet = r.content[:200].replace("\n", " ")
        if len(r.content) > 200:
            snippet += "..."
        print(f"  {snippet}")


def _error(msg: str) -> None:
    print(json.dumps({"error": msg}), file=sys.stderr)
    sys.exit(1)
