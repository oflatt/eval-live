"""Resolve immutable Git targets and manage library-owned detached worktrees."""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
from pathlib import Path, PurePosixPath
import subprocess
import tempfile
from typing import Iterator, Sequence

from .benchmarks import file_digest


def git(repository: Path, *arguments: str) -> str:
    """Run Git with an argument vector and return UTF-8 output."""
    result = subprocess.run(["git", "-C", str(repository), *arguments],
                            capture_output=True, text=True, check=False)
    if result.returncode:
        raise ValueError(f"Git {' '.join(arguments)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


@dataclass(frozen=True)
class Target:
    """A ref resolved to a repository and full commit before collection."""

    repository: Path
    identity: str
    ref: str
    commit: str
    working: bool
    dirty: bool

    @classmethod
    def resolve(cls, repository: str | Path, ref: str, *, allow_dirty: bool = False) -> Target:
        """Resolve a ref without modifying or checking out the user's tree."""
        root = Path(git(Path(repository).expanduser().resolve(), "rev-parse", "--show-toplevel"))
        working = ref == "WORKTREE"
        sha = git(root, "rev-parse", "--verify", "--end-of-options",
                  ("HEAD" if working else ref) + "^{commit}")
        common = git(root, "rev-parse", "--git-common-dir")
        identity = str((root / common).resolve())
        dirty = working and bool(git(root, "status", "--porcelain"))
        if dirty and not allow_dirty:
            raise ValueError("WORKTREE is dirty; commit changes or explicitly pass --allow-dirty")
        return cls(root, identity, ref, sha, working, dirty)

    def input_hashes(self, inputs: Sequence[str | Path]) -> list[dict]:
        """Hash declared files/directories at the target revision or externally."""
        result = {}
        for raw in inputs:
            path = Path(raw)
            if path.is_absolute() or self.working:
                physical = path if path.is_absolute() else self.repository / path
                if not physical.exists():
                    raise ValueError(f"input does not exist: {physical}")
                files = sorted(p for p in physical.rglob("*") if p.is_file()) if physical.is_dir() else [physical]
                if not files:
                    result[str(raw)] = hashlib.sha256(b"").hexdigest()
                for file in files:
                    name = str(file) if path.is_absolute() else file.relative_to(self.repository).as_posix()
                    result[name] = file_digest(file)
            else:
                name = path.as_posix()
                if ".." in PurePosixPath(name).parts or name.startswith("-"):
                    raise ValueError("relative input paths must stay inside the target repository")
                tree = git(self.repository, "ls-tree", "-r", "-z", self.commit, "--", name)
                if not tree:
                    raise ValueError(f"input {name!r} does not exist at {self.commit}")
                for entry in tree.split("\0"):
                    if not entry:
                        continue
                    info, filename = entry.split("\t", 1)
                    mode, kind, object_id = info.split()
                    if kind != "blob" or mode == "120000":
                        raise ValueError("declare actual files instead of symlinks or submodules as inputs")
                    blob = subprocess.check_output(["git", "-C", str(self.repository), "cat-file", "blob", object_id])
                    result[filename] = hashlib.sha256(blob).hexdigest()
        return [{"path": name, "sha256": value} for name, value in sorted(result.items())]

    @contextmanager
    def checkout(self) -> Iterator[Path]:
        """Yield a working directory and remove only library-owned worktrees."""
        if self.working:
            yield self.repository
            return
        with tempfile.TemporaryDirectory(prefix="eval-live-") as temporary:
            directory = Path(temporary) / "target"
            try:
                git(self.repository, "worktree", "add", "--quiet", "--detach", str(directory), self.commit)
                yield directory
            finally:
                if (directory / ".git").exists():
                    git(self.repository, "worktree", "remove", "--force", str(directory))

    def inputs_match(self, inputs: Sequence[str | Path], expected: list[dict],
                     directory: Path | None = None) -> bool:
        """Check mutable inputs against the plan, and a checkout against its commit.

        Committed directories include tracked files only. Git applies its clean
        filters when checking checkout contents; generated untracked files do not
        invalidate them. Absolute inputs and WORKTREE use filesystem hashes.
        With no checkout, only mutable inputs need checking.
        """
        if self.working:
            return self.input_hashes(inputs) == expected
        external = [path for path in inputs if Path(path).is_absolute()]
        if self.input_hashes(external) != [row for row in expected if Path(row["path"]).is_absolute()]:
            return False
        relative = [str(path) for path in inputs if not Path(path).is_absolute()]
        return directory is None or not relative or not git(
            directory, "diff", "--name-only", self.commit, "--", *relative)


def script_revision(script: Path | None) -> dict:
    """Describe the evaluation script separately from benchmark target revisions."""
    result = {"script": str(script) if script else None, "script_sha256": None,
              "script_commit": None, "script_dirty": None}
    if script and script.is_file():
        result["script_sha256"] = file_digest(script)
        try:
            result["script_commit"] = git(script.parent, "rev-parse", "HEAD")
            result["script_dirty"] = bool(git(script.parent, "status", "--porcelain"))
        except ValueError:
            pass
    return result
