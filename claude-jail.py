#!/usr/bin/env python3
"""claude-jail: run Claude Code in an isolated Docker container."""

import argparse
import os
import platform
import subprocess
import sys
from pathlib import Path


def is_wsl() -> bool:
    """Detect if running inside WSL."""
    try:
        with open("/proc/version") as f:
            content = f.read().lower()
            return "microsoft" in content or "wsl" in content
    except FileNotFoundError:
        return False


def to_docker_path(path: "Path | str") -> str:
    """Convert a local path to a Docker-compatible volume mount path.

    On Windows, converts C:\\Users\\foo → /c/Users/foo.
    On Linux/Mac/WSL, returns the path unchanged.
    """
    if platform.system() == "Windows":
        from pathlib import PureWindowsPath
        wp = PureWindowsPath(path)
        drive = wp.drive.rstrip(":").lower()
        rest = "/".join(wp.parts[1:])
        return f"/{drive}/{rest}"
    return str(path)


def build_docker_cmd(
    image: str,
    claude_dir: Path,
    workspace: Path,
    is_tty: bool,
    no_update: bool,
    skip_permissions: bool,
    extra_args: list,
) -> list:
    """Build the docker run command list."""
    cmd = [
        "docker", "run",
        "--rm",
        "-it" if is_tty else "-i",
        "-v", f"{to_docker_path(claude_dir)}:/root/.claude:rw",
        "-v", f"{to_docker_path(workspace)}:/workspace:rw",
        "-w", "/workspace",
        image,
    ]

    if no_update:
        cmd.append("--no-update")
    if skip_permissions:
        cmd.append("--dangerously-skip-permissions")
    cmd.extend(extra_args)

    return cmd


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Run Claude Code in an isolated Docker container",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
examples:
  python claude-jail.py                              interactive session
  python claude-jail.py --no-update                  skip Claude update on start
  python claude-jail.py --dangerously-skip-permissions  no permission prompts
  python claude-jail.py -- --model claude-opus-4-7   pass args to Claude
  python claude-jail.py --image myrepo/image:v1.0    use a specific image
        """,
    )
    parser.add_argument(
        "--no-update",
        action="store_true",
        help="Skip Claude Code auto-update on container start",
    )
    parser.add_argument(
        "--dangerously-skip-permissions",
        action="store_true",
        help="Run Claude without permission prompts",
    )
    parser.add_argument(
        "--image",
        default="feliperibeiro95/claude-jail-code:latest",
        help="Docker image to use (default: feliperibeiro95/claude-jail-code:latest)",
    )
    parser.add_argument(
        "claude_args",
        nargs=argparse.REMAINDER,
        help="Additional arguments passed to Claude (use -- to separate)",
    )

    args = parser.parse_args(argv)

    extra_args = args.claude_args
    if extra_args and extra_args[0] == "--":
        extra_args = extra_args[1:]

    claude_dir = Path.home() / ".claude"
    workspace = Path.cwd()
    is_tty = sys.stdin.isatty()

    cmd = build_docker_cmd(
        image=args.image,
        claude_dir=claude_dir,
        workspace=workspace,
        is_tty=is_tty,
        no_update=args.no_update,
        skip_permissions=args.dangerously_skip_permissions,
        extra_args=extra_args,
    )

    try:
        result = subprocess.run(cmd)
        return result.returncode
    except FileNotFoundError:
        print(
            "Error: 'docker' command not found. Please install Docker Desktop.",
            file=sys.stderr,
        )
        return 1
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
