import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = (ROOT / "cloud-init.sh.tftpl").read_text()


class FirewallProxyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.commands = self.directory / "bin"
        self.commands.mkdir()
        import os
        self.environment = {**os.environ, "PATH": f"{self.commands}:{os.environ['PATH']}",
                            "HOME": str(self.directory)}

    def mock(self, name, body):
        path = self.commands / name
        path.write_text("#!/usr/bin/env bash\n" + body)
        path.chmod(0o700)

    def test_cloud_init_uses_ufw_matching_herobids_convention(self):
        self.assertIn("ufw default deny incoming", TEMPLATE)
        self.assertIn("ufw default allow outgoing", TEMPLATE)
        self.assertIn("ufw allow 22/tcp", TEMPLATE)
        # TLS model: Caddy terminates on 80/443; the boundary is internal-only.
        self.assertIn("ufw allow 80/tcp", TEMPLATE)
        self.assertIn("ufw allow 443/tcp", TEMPLATE)
        self.assertIn("ufw --force enable", TEMPLATE)
        # The old DOCKER-USER iptables chain must not remain.
        self.assertNotIn("TRADERTON_BOUNDARY", TEMPLATE)
        self.assertNotIn("iptables", TEMPLATE)
        self.assertNotIn("DOCKER-USER", TEMPLATE)

    def test_deploy_requires_ufw_80_443_allow(self):
        deploy = (ROOT / "deploy-on-host.sh").read_text()
        self.assertIn("ufw status", deploy)
        self.assertIn('UFW ${port}/tcp allow is absent', deploy)
        self.assertIn("for port in 80 443", deploy)

    def test_site_proxy_denies_exact_execution_paths(self):
        caddyfile = (ROOT / "Caddyfile.staging").read_text()
        paths = set([p for p in caddyfile.split("@execution path ", 1)[1].split("\n")[0].split()])
        for path in ("/internal", "/internal/secret", "/health", "/health/ready"):
            self.assertTrue(any(path == pattern or
                                (pattern.endswith("/*") and path.startswith(pattern[:-1]))
                                for pattern in paths), path)
        self.assertIn("respond @execution 404", caddyfile)
        self.assertIn("reverse_proxy boundary:8080", caddyfile)

    def test_deploy_stops_before_mount_when_ufw_80_443_missing(self):
        marker = self.directory / "host-marker"
        marker.touch()
        mount = self.directory / "mount-data.sh"
        mount.write_text("#!/bin/bash\ntouch mounted\n")
        mount.chmod(0o700)
        sha = "a" * 40
        (self.directory / ".env.staging").write_text(
            "POSTGRES_PASSWORD=fixture\n"
            "REDIS_URL=redis://fixture\nBOUNDARY_CONSUMER_ID=fixture\n"
            "BOUNDARY_KEY_ID=fixture\nBOUNDARY_SIGNING_SECRET=fixture\n"
            f"CREDENTIAL_ENCRYPTION_KEY={'e' * 64}\n"
            "GHCR_USERNAME=fixture\nGHCR_TOKEN=fixture\n")
        deploy = (ROOT / "deploy-on-host.sh").read_text().replace(
            "/etc/traderton-staging/host-marker", str(marker))
        (self.directory / "deploy.sh").write_text(deploy)
        for command, body in {
            "hostname": "echo traderton-staging\n",
            "id": "echo 0\n",
            "stat": "if [[ \"$2\" == %a ]]; then echo 600; else echo 0; fi\n",
            # ufw returns nothing -> allows absent -> fail before mount
            "ufw": "exit 0\n",
        }.items():
            self.mock(command, body)
        result = subprocess.run(["bash", str(self.directory / "deploy.sh"), "--confirm-staging", sha],
                                cwd=self.directory, env=self.environment, capture_output=True, text=True,
                                check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("80/tcp allow is absent", result.stderr)
        self.assertFalse((self.directory / "mounted").exists())

    def test_failed_readiness_records_non_success_release(self):
        marker = self.directory / "host-marker"
        marker.touch()
        mount = self.directory / "mount-data.sh"
        mount.write_text("#!/bin/bash\nexit 0\n")
        mount.chmod(0o700)
        sha = "a" * 40
        (self.directory / ".env.staging").write_text(
            "POSTGRES_PASSWORD=fixture\n"
            "REDIS_URL=redis://fixture\nBOUNDARY_CONSUMER_ID=fixture\n"
            "BOUNDARY_KEY_ID=fixture\nBOUNDARY_SIGNING_SECRET=fixture\n"
            f"CREDENTIAL_ENCRYPTION_KEY={'e' * 64}\n"
            "GHCR_USERNAME=fixture\nGHCR_TOKEN=fixture\n")
        deploy = (ROOT / "deploy-on-host.sh").read_text().replace(
            "/etc/traderton-staging/host-marker", str(marker)).replace(
            "/etc/traderton-staging/release-sha", str(self.directory / "release-sha")).replace(
            "/etc/traderton-staging/image-digest", str(self.directory / "image-digest"))
        (self.directory / "deploy.sh").write_text(deploy)
        self.mock("docker", "for a in \"$@\"; do [[ \"$a\" == exec ]] && exit 1; done\nexit 0\n")
        for command, body in {
            "hostname": "echo traderton-staging\n",
            "id": "echo 0\n",
            "stat": "if [[ \"$2\" == %a ]]; then echo 600; else echo 0; fi\n",
            "ufw": "printf '22/tcp\\tALLOW\\n80/tcp\\tALLOW\\n443/tcp\\tALLOW\\n'\n",
            "install": "exit 0\n",
            "systemctl": "exit 0\n",
            "sleep": "exit 0\n",
        }.items():
            self.mock(command, body)
        result = subprocess.run(["bash", str(self.directory / "deploy.sh"), "--confirm-staging", sha],
                                cwd=self.directory, env=self.environment, capture_output=True, text=True,
                                check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.directory / "release-sha").read_text().strip(), "failed")
        self.assertEqual((self.directory / "image-digest").read_text().strip(), "failed")


if __name__ == "__main__":
    unittest.main()