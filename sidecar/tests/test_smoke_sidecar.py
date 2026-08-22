from __future__ import annotations

import importlib.util
import io
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("smoke_sidecar", SCRIPTS / "smoke-sidecar.py")
assert SPEC is not None and SPEC.loader is not None
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


class SmokeSidecarEncodingTests(unittest.TestCase):
    def test_utf8_diagnostics_bypass_cp1252_text_encoding(self) -> None:
        raw = io.BytesIO()
        stream = io.TextIOWrapper(raw, encoding="cp1252")
        original = SMOKE.sys.stderr
        SMOKE.sys.stderr = stream
        try:
            SMOKE.write_utf8_stderr("中文错误：libmklml_intel.so")
        finally:
            SMOKE.sys.stderr = original

        self.assertEqual(raw.getvalue().decode("utf-8").strip(), "中文错误：libmklml_intel.so")


if __name__ == "__main__":
    unittest.main()
