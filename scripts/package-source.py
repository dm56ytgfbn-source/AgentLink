#!/usr/bin/env python3
"""Export reviewable source only; never overwrite or clean existing artifacts."""
import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIRECTORIES = {"apps": {".ts"}, "packages": {".ts"}, "adapters": {".ts"},
               "tests": {".ts"}, "scripts": {".mjs", ".ps1", ".py"},
               "scripts/windows-package": {".cmd", ".txt"},
               "mac": {".swift"}, "agents": {".md"}, "windows": {".cs"}}
FILES = ["LICENSE", "Mac-启动键鼠共享.command", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.windows-node.json",
         "agents/AGENT-GUIDE.md",
         "native/AgentLinkWindowApp.swift", "native/Mount.swift", "native/InputShareMac.swift", "native/InputShareWindows.cs", "docs/INPUT-SHARING.md", "examples/input-share-layout.example.json", "SECURITY.md",
         "docs/SETUP.md", "docs/RELEASE-ACCEPTANCE.md", "docs/PROTOCOL.md", "docs/AGENT-INTEGRATION.md",
         "docs/PUBLIC-README.md", "docs/RELEASE-NOTES-ZH.md", "docs/PEER-ARCHITECTURE-2026-10-02.md",
         "examples/mcp-config.example.json", ".github/workflows/ci.yml"]
IGNORE = """node_modules/
dist/
build/
*.local.json
*.pem
*.key
*.log
*.jsonl
.DS_Store
.agentlink-context
certificates/
Backups/
"""


def credential_values(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key.lower() in {"token", "password", "secret", "api_key"} and isinstance(item, str) and len(item) >= 8:
                yield item.encode()
            else:
                yield from credential_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from credential_values(item)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--archive", action="store_true", help="Also create a ZIP after owner acceptance")
    args = parser.parse_args()
    output = args.output.expanduser().absolute()
    archive = output.with_name(output.name + ".zip")
    if output.exists() or output.is_symlink() or (args.archive and (archive.exists() or archive.is_symlink())):
        raise SystemExit("Output already exists; preserved. Choose a new path.")
    if output.resolve().is_relative_to(ROOT):
        raise SystemExit("Export outside the source directory.")

    # Read known local credentials only for exact-match checks; never print their values.
    secrets = []
    private_files = list(ROOT.glob("*.local.json"))
    private_files += list((Path.home() / "Library/Application Support/AgentLink/config").glob("*.local.json"))
    for filename in private_files:
        secrets.extend(credential_values(json.loads(filename.read_text())))

    selected = {name: ROOT / name for name in FILES}
    for directory, extensions in DIRECTORIES.items():
        for filename in (ROOT / directory).rglob("*"):
            if filename.is_symlink():
                raise SystemExit("Symlink in source allowlist; export stopped.")
            if filename.is_file() and filename.suffix in extensions:
                selected[filename.relative_to(ROOT).as_posix()] = filename
    content = {".gitignore": IGNORE.encode()}
    personal_home = str(Path.home()).encode()
    for relative, filename in sorted(selected.items()):
        parts = filename.relative_to(ROOT).parts
        if any(ROOT.joinpath(*parts[:count]).is_symlink() for count in range(1, len(parts) + 1)):
            raise SystemExit("Symlink in selected source; export stopped.")
        data = filename.read_bytes()
        if re.search(rb"-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----", data) or any(secret in data for secret in secrets):
            raise SystemExit("Sensitive content detected in " + relative + "; no export created.")
        if personal_home != b"/" and personal_home in data:
            raise SystemExit("Personal home path detected in " + relative + "; no export created.")
        content[relative] = data
    content["README.md"] = content["docs/PUBLIC-README.md"]
    manifest = {name: hashlib.sha256(data).hexdigest() for name, data in sorted(content.items())}
    content["SOURCE-MANIFEST.json"] = (json.dumps({"algorithm": "sha256", "files": manifest}, indent=2) + "\n").encode()
    output.mkdir(parents=True, exist_ok=False)
    for relative, data in sorted(content.items()):
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("xb") as stream:
            stream.write(data)
        if relative.endswith(".command"):
            destination.chmod(0o755)
    if args.archive:
        with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED) as bundle:
            for relative, data in sorted(content.items()):
                bundle.writestr(output.name + "/" + relative, data)
    print(json.dumps({"source": str(output), "files": len(content), "archive": str(archive) if args.archive else None,
                      "status": "review candidate; owner acceptance required before publication"}, indent=2))


if __name__ == "__main__":
    main()
