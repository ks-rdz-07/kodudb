"""Fail a pull request that adds executable or archive files, or binaries outside the allowed media folders.
Usage: python .github/scripts/check_binaries.py origin/main"""
import subprocess
import sys

BLOCKED = (".exe", ".dll", ".sys", ".scr", ".com", ".msi", ".msix", ".appx", ".cab", ".bat", ".cmd", ".vbs",
           ".vbe", ".jse", ".wsf", ".hta", ".lnk", ".jar", ".zip", ".7z", ".rar", ".iso", ".img", ".pyc",
           ".pyd", ".so", ".dylib", ".bin")
MEDIA_DIRS = ("docs/images/", "docs/media/", "docs/samples/")


def changed(base):
    out = subprocess.run(["git", "diff", "--name-only", "--diff-filter=AMR", f"{base}...HEAD"],
                         capture_output=True, text=True, check=True).stdout
    return [f for f in out.splitlines() if f]


def is_binary(path):
    try:
        with open(path, "rb") as fh:
            return b"\0" in fh.read(8192)
    except OSError:
        return False


def main(base):
    bad = []
    for f in changed(base):
        low = f.lower()
        if low.endswith(BLOCKED):
            bad.append(f"{f}: executable/archive files are not accepted in pull requests")
        elif is_binary(f) and not low.startswith(MEDIA_DIRS):
            bad.append(f"{f}: binary file outside {', '.join(MEDIA_DIRS)}")
    for b in bad:
        print(f"::error file={b.split(':')[0]}::{b}")
    if bad:
        sys.exit(1)
    print("No unexpected binaries.")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "origin/main")
