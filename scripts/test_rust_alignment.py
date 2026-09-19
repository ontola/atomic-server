import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("alignment", Path(__file__).with_name("check-rust-alignment.py"))
alignment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alignment)


class AlignmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.server = Path(self.temp.name) / "server"
        self.saas = Path(self.temp.name) / "saas"
        for root in [self.server, self.saas]:
            (root / ".github/workflows").mkdir(parents=True)
            (root / "rust-toolchain.toml").write_text('[toolchain]\nchannel="1.98.1"\n')
            (root / "Cargo.toml").write_text('[profile.dev]\ndebug="line-tables-only"\n')
            packages = alignment.SHARED | {"loro-internal"}
            (root / "Cargo.lock").write_text("\n".join(
                f'[[package]]\nname="{name}"\nversion="1.0.0"\nsource="registry+https://example.org"\n'
                for name in sorted(packages)
            ))

    def check(self):
        return alignment.check_pair(self.server, self.saas)

    def test_matching_pair(self):
        self.assertEqual(self.check(), [])

    def test_toolchain_drift(self):
        (self.saas / "rust-toolchain.toml").write_text('[toolchain]\nchannel="1.97.0"\n')
        self.assertIn("rust-toolchain.toml differs", "\n".join(self.check()))

    def test_floating_workflow_pin(self):
        (self.server / ".github/workflows/ci.yml").write_text('steps:\n- uses: dtolnay/rust-toolchain@stable\n')
        self.assertIn("Rust stable differs", "\n".join(self.check()))

    def test_profile_drift(self):
        (self.saas / "Cargo.toml").write_text('[profile.dev]\ndebug=true\n')
        self.assertIn("profile.dev differs", "\n".join(self.check()))

    def test_transitive_loro_drift(self):
        p = self.saas / "Cargo.lock"
        p.write_text(p.read_text().replace('name="loro-internal"\nversion="1.0.0"', 'name="loro-internal"\nversion="1.1.0"'))
        self.assertIn("loro-internal:", "\n".join(self.check()))

    def test_missing_critical_dependency(self):
        p = self.saas / "Cargo.lock"
        p.write_text(p.read_text().replace('name="iroh"', 'name="something-else"'))
        self.assertIn("iroh:", "\n".join(self.check()))

    def test_additional_crypto_version_is_drift(self):
        p = self.saas / "Cargo.lock"
        p.write_text(p.read_text() + '\n[[package]]\nname="ed25519-dalek"\nversion="3.0.0-rc.1"\nsource="registry+https://example.org"\n')
        self.assertIn("ed25519-dalek:", "\n".join(self.check()))

    def test_unrelated_dependency_can_differ(self):
        p = self.saas / "Cargo.lock"
        p.write_text(p.read_text() + '\n[[package]]\nname="redb"\nversion="2.6.3"\nsource="registry+https://example.org"\n')
        self.assertEqual(self.check(), [])


if __name__ == "__main__":
    unittest.main()
