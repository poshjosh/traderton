import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


class BackupAlertTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.commands = self.directory / "bin"
        self.commands.mkdir()
        self.environment = {**os.environ, "PATH": f"{self.commands}:{os.environ['PATH']}",
                            "ALERT_LOG": str(self.directory / "alert.log"),
                            "MOCK_OWNER": "0"}
        self.mock("stat", 'if [[ "$2" == %u ]]; then printf "%s\\n" "$MOCK_OWNER"; else printf "600\\n"; fi\n')
        self.mock("logger", 'printf "%s\\n" "$*" >> "$ALERT_LOG"\n')

    def mock(self, name, body):
        path = self.commands / name
        path.write_text("#!/usr/bin/env bash\n" + body)
        path.chmod(0o700)

    def run_script(self, script, *args):
        return subprocess.run(["bash", str(script), *map(str, args)], cwd=self.directory,
                              env=self.environment, capture_output=True, text=True, check=False)

    def test_failure_alert_reaches_configured_email(self):
        shutil.copy(ROOT / "backup-alert.sh", self.directory / "backup-alert.sh")
        (self.directory / ".env.backup").write_text("ALERT_TO=ops@example.test\nALERT_FROM=traderton@example.test\n")
        self.mock("sendmail", 'printf "%s\\n" "$*" > "$ALERT_LOG"\ncat >> "$ALERT_LOG"\n')
        self.mock("hostname", "echo traderton-staging\n")
        self.mock("date", "echo 2026-09-25T00:00:00Z\n")
        result = self.run_script(self.directory / "backup-alert.sh", "failed")
        self.assertEqual(result.returncode, 0, result.stderr)
        sent = (self.directory / "alert.log").read_text()
        self.assertIn("Traderton staging backup failed", sent)
        self.assertIn("ops@example.test", sent)

    def test_missing_channel_fails_closed_without_delivery(self):
        shutil.copy(ROOT / "backup-alert.sh", self.directory / "backup-alert.sh")
        (self.directory / ".env.backup").write_text("ALERT_TO=\n")
        self.mock("sendmail", 'touch "$ALERT_LOG"\n')
        self.mock("hostname", "echo traderton-staging\n")
        result = self.run_script(self.directory / "backup-alert.sh", "failed")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ALERT_TO not configured", (self.directory / "alert.log").read_text())

    def test_failed_sendmail_delivery_logs_a_fallback_alert(self):
        shutil.copy(ROOT / "backup-alert.sh", self.directory / "backup-alert.sh")
        (self.directory / ".env.backup").write_text("ALERT_TO=ops@example.test\n")
        self.mock("sendmail", "cat > /dev/null\nexit 22\n")
        self.mock("hostname", "echo traderton-staging\n")
        self.mock("date", "echo 2026-09-25T00:00:00Z\n")
        self.mock("mail", "echo 'no mail' > /dev/null\nexit 22\n")
        self.mock("mailx", "echo 'no mailx' > /dev/null\nexit 22\n")
        result = self.run_script(self.directory / "backup-alert.sh", "failed")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no sendmail/mail available", (self.directory / "alert.log").read_text())

    def test_backup_mount_and_upload_failures_are_reported_by_systemd_alert(self):
        self.assertIn("OnFailure=traderton-backup-alert.service", (ROOT / "traderton-backup.service").read_text())
        self.assertIn("ExecStart=/bin/bash /opt/traderton/staging/backup-alert.sh failed",
                      (ROOT / "traderton-backup-alert.service").read_text())
        self.assertIn("traderton-backup-alert.service", (ROOT / "deploy-on-host.sh").read_text())
        shutil.copy(ROOT / "backup-job.sh", self.directory / "backup-job.sh")
        shutil.copy(ROOT / "backup-alert.sh", self.directory / "backup-alert.sh")
        (self.directory / ".env.backup").write_text("ALERT_TO=ops@example.test\n")
        self.mock("sendmail", 'printf "%s\\n" "$*" >> "$ALERT_LOG"\ncat >> "$ALERT_LOG"\n')
        self.mock("hostname", "echo traderton-staging\n")
        self.mock("date", "echo 2026-09-25T00:00:00Z\n")
        self.mock("mountpoint", "exit 1\n")
        self.assertNotEqual(self.run_script(self.directory / "backup-job.sh").returncode, 0)
        self.assertFalse((self.directory / "alert.log").exists())
        self.assertEqual(self.run_script(self.directory / "backup-alert.sh", "failed").returncode, 0)
        self.assertIn("Traderton staging backup failed", (self.directory / "alert.log").read_text())

        (self.directory / "alert.log").unlink()
        self.mock("mountpoint", "exit 0\n")
        self.mock("mktemp", 'mkdir -p "$MOCK_TEMP_DIR"; printf "%s\\n" "$MOCK_TEMP_DIR"\n')
        self.mock("docker", 'exit 0\n')
        self.mock("restic", 'exit 1\n')
        self.environment["MOCK_TEMP_DIR"] = str(self.directory / "dump")
        self.assertNotEqual(self.run_script(self.directory / "backup-job.sh").returncode, 0)
        self.assertEqual(self.run_script(self.directory / "backup-alert.sh", "failed").returncode, 0)
        self.assertIn("Traderton staging backup failed", (self.directory / "alert.log").read_text())

    def test_preflight_failure_can_alert_without_backup_credentials(self):
        script = ROOT / "backup.sh"
        marker = self.directory / "host-marker"
        marker.touch()
        (self.directory / "backup.sh").write_text(script.read_text().replace(
            "/etc/traderton-staging/host-marker", str(marker)))
        shutil.copy(ROOT / "backup-alert.sh", self.directory / "backup-alert.sh")
        (self.directory / ".env.backup").write_text("ALERT_TO=ops@example.test\n")
        self.mock("id", "printf '0\\n'\n")
        self.mock("sendmail", 'printf "%s\\n" "$*" >> "$ALERT_LOG"\ncat >> "$ALERT_LOG"\n')
        self.mock("hostname", "echo traderton-staging\n")
        self.mock("date", "echo 2026-09-25T00:00:00Z\n")
        self.assertIn("Missing backup credential", self.run_script(self.directory / "backup.sh").stderr)
        self.assertEqual(self.run_script(self.directory / "backup-alert.sh", "failed").returncode, 0)
        self.assertIn("Traderton staging backup failed", (self.directory / "alert.log").read_text())

    def test_rejects_non_root_owned_env_files_before_sourcing(self):
        marker = self.directory / "host-marker"
        marker.touch()
        self.mock("id", "printf '0\\n'\n")
        self.mock("hostname", "printf 'traderton-staging\\n'\n")
        self.environment["MOCK_OWNER"] = "1000"
        for name, script, args in (
            ("backup.sh", ROOT / "backup.sh", ()),
            ("deploy.sh", ROOT / "deploy-on-host.sh", ("--confirm-staging", "a" * 40))):
            with self.subTest(script=name):
                (self.directory / name).write_text(script.read_text().replace(
                    "/etc/traderton-staging/host-marker", str(marker)))
                (self.directory / (".env.backup" if name == "backup.sh" else ".env.staging")).write_text(
                    "SHOULD_NOT_SOURCE=1\n")
                result = self.run_script(self.directory / name, *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("root-owned", result.stderr)
                self.assertNotIn("SHOULD_NOT_SOURCE", result.stderr)

        self.environment["MOCK_OWNER"] = "0"
        self.assertIn("Missing backup credential", self.run_script(self.directory / "backup.sh").stderr)
        self.assertIn("Missing POSTGRES_PASSWORD", self.run_script(self.directory / "deploy.sh", *args).stderr)

    def test_health_rejects_non_root_owned_backup_configuration_before_sourcing(self):
        marker = self.directory / "host-marker"
        marker.touch()
        script = ROOT / "backup-health.sh"
        (self.directory / "backup-health.sh").write_text(script.read_text().replace(
            "/etc/traderton-staging/host-marker", str(marker)))
        (self.directory / ".env.backup").write_text("exit 77\n")
        self.mock("id", "printf '0\n'\n")
        self.environment["MOCK_OWNER"] = "1000"
        result = self.run_script(self.directory / "backup-health.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("root-owned", result.stderr)
        self.assertNotEqual(result.returncode, 77)

    def test_stale_or_missing_success_alerts_but_recent_success_does_not(self):
        marker = self.directory / "last-success"
        alert = self.commands / "alert"
        self.mock("alert", 'printf "%s\\n" "$1" >> "$ALERT_LOG"\n')
        self.mock("stat", 'printf "%s\\n" "$MOCK_MTIME"\n')
        check = ROOT / "check-backup-success.sh"
        self.environment["MOCK_MTIME"] = str(int(time.time()))
        self.assertNotEqual(self.run_script(check, marker, alert).returncode, 0)
        marker.touch()
        self.environment["MOCK_MTIME"] = str(int(time.time()) - 129601)
        self.assertNotEqual(self.run_script(check, marker, alert).returncode, 0)
        self.environment["MOCK_MTIME"] = str(int(time.time()))
        self.assertEqual(self.run_script(check, marker, alert).returncode, 0)
        self.environment["MOCK_MTIME"] = str(int(time.time()) + 3600)
        self.assertNotEqual(self.run_script(check, marker, alert).returncode, 0)
        self.assertEqual((self.directory / "alert.log").read_text().splitlines(), ["stale", "stale", "stale"])


if __name__ == "__main__":
    unittest.main()