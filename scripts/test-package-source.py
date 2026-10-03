#!/usr/bin/env python3
"""Publication boundary checks. All fixtures are retained; no cleanup runs."""
import contextlib
import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("exporter", Path(__file__).with_name("package-source.py"))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="agentlink-export-retained-"))
        self.source = self.base / "source"
        self.source.mkdir()
        for relative in exporter.FILES:
            filename = self.source / relative
            filename.parent.mkdir(parents=True, exist_ok=True)
            filename.write_text("public fixture\n")
        for directory in exporter.DIRECTORIES:
            (self.source / directory).mkdir(exist_ok=True)
        self.output = self.base / "candidate"

    def run_export(self, archive=False):
        args = ["package-source.py", str(self.output)] + (["--archive"] if archive else [])
        with patch.object(exporter, "ROOT", self.source), patch.object(sys, "argv", args), contextlib.redirect_stdout(io.StringIO()):
            exporter.main()

    def test_allowlist_manifest_archive_and_preserved_source(self):
        private = self.source / "runtime.local.json"
        private.write_text(json.dumps({"token": "retained-fixture-secret-12345"}))
        (self.source / "docs/private-notes.md").write_text("private notes")
        windows_script = self.source / "scripts/windows-package/启动.cmd"
        windows_script.parent.mkdir(parents=True, exist_ok=True)
        windows_script.write_text("@echo off\n")
        self.run_export(archive=True)
        self.assertTrue(private.exists())
        self.assertFalse((self.output / private.name).exists())
        self.assertFalse((self.output / "docs/private-notes.md").exists())
        self.assertEqual((self.output / "scripts/windows-package/启动.cmd").read_text(), "@echo off\n")
        manifest = json.loads((self.output / "SOURCE-MANIFEST.json").read_text())
        for relative, digest in manifest["files"].items():
            self.assertEqual(hashlib.sha256((self.output / relative).read_bytes()).hexdigest(), digest)
        with zipfile.ZipFile(self.output.with_suffix(".zip")) as bundle:
            self.assertEqual(len(bundle.namelist()), len(manifest["files"]) + 1)
            self.assertFalse(any("runtime.local.json" in name for name in bundle.namelist()))

    def test_known_credential_leak_fails_before_export(self):
        token = "retained-fixture-secret-12345"
        (self.source / "runtime.local.json").write_text(json.dumps({"devices": [{"token": token}]}))
        (self.source / "docs/SETUP.md").write_text(token)
        with self.assertRaisesRegex(SystemExit, "Sensitive content"):
            self.run_export()
        self.assertFalse(self.output.exists())

    def test_private_key_leak_fails_before_export(self):
        (self.source / "docs/SETUP.md").write_text("-----BEGIN " + "PRIVATE KEY-----")
        with self.assertRaisesRegex(SystemExit, "Sensitive content"):
            self.run_export()
        self.assertFalse(self.output.exists())

    def test_existing_output_is_preserved(self):
        self.output.mkdir()
        original = self.output / "owner.txt"
        original.write_text("preserve me")
        with self.assertRaisesRegex(SystemExit, "already exists"):
            self.run_export()
        self.assertEqual(original.read_text(), "preserve me")

    @unittest.skipIf(sys.platform == "win32", "Windows symlink permission is not assumed")
    def test_symlink_is_rejected(self):
        (self.source / "apps/outside.ts").symlink_to(self.source / "docs/SETUP.md")
        with self.assertRaisesRegex(SystemExit, "Symlink"):
            self.run_export()
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
