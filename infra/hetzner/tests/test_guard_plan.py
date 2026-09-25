import copy
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
VALID = json.loads((ROOT / "fixtures/valid-plan.json").read_text())


def resource(plan, address):
    return next(change for change in plan["resource_changes"] if change["address"] == address)


class PlanGuardTests(unittest.TestCase):
    def assert_plan(self, plan, accepted):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plan.json"
            path.write_text(json.dumps(plan))
            result = subprocess.run(["python3", str(ROOT / "guard-plan.py"), str(path)],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode == 0, accepted, result.stderr)

    def test_accepts_valid_plan_and_rejects_public_ssh_fixture(self):
        self.assert_plan(VALID, True)
        self.assert_plan(json.loads((ROOT / "fixtures/invalid-public-plan.json").read_text()), False)

    def test_rejects_mutated_topology_and_actions(self):
        mutations = [
            lambda plan: resource(plan, "hcloud_server.staging")["change"].update(actions=["update"]),
            lambda plan: resource(plan, "hcloud_server.staging")["change"].update(actions=["delete", "create"]),
            lambda plan: plan["variables"]["ssh_source_cidrs"].update(value=["0.0.0.0/1", "128.0.0.0/1"]),
            lambda plan: resource(plan, "hcloud_firewall.staging")["change"]["after"]["rule"][0].update(source_ips=["0.0.0.0/1", "128.0.0.0/1"]),
            lambda plan: resource(plan, "hcloud_firewall.staging")["change"]["after"]["rule"][1].update(source_ips=["192.0.2.0/24"]),
            lambda plan: resource(plan, "hcloud_firewall.staging")["change"]["after"]["rule"].append({"direction": "in", "protocol": "tcp", "port": "8080", "source_ips": ["0.0.0.0/0"]}),
            lambda plan: plan["configuration"]["root_module"]["resources"][2]["expressions"]["ssh_keys"].update(references=["var.other_key"]),
            lambda plan: plan["configuration"]["root_module"]["resources"][4]["expressions"]["volume_id"].update(references=["var.other_volume"]),
            lambda plan: resource(plan, "hcloud_server.staging")["change"]["after"].update(location="nbg1"),
            lambda plan: plan["resource_changes"].append(copy.deepcopy(plan["resource_changes"][0])),
            lambda plan: plan.update(complete=False),
            lambda plan: resource(plan, "hcloud_ssh_key.staging")["change"]["after"].update(public_key="ssh-ed25519 different"),
            lambda plan: resource(plan, "hcloud_ssh_key.staging")["change"]["after"].update(name="traderton-other"),
            lambda plan: resource(plan, "hcloud_server.staging")["change"]["after"].update(user_data="#!/bin/bash\nexit 0\n"),
            lambda plan: resource(plan, "hcloud_volume.data")["change"]["after"].update(size=100),
            lambda plan: resource(plan, "hcloud_volume_attachment.data")["change"]["after"].update(automount=True),
            lambda plan: plan["variables"]["ssh_public_key"].update(value="not a public key"),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                plan = copy.deepcopy(VALID)
                mutate(plan)
                self.assert_plan(plan, False)

    def test_workflow_rechecks_the_same_saved_plan_before_apply(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            command = root / "terraform"
            command.write_text("#!/usr/bin/env bash\n"
                               'printf "%s\\n" "$*" >> "$MOCK_CALLS"\n'
                               'case "$1" in\n'
                               '  workspace) exit 0 ;;\n'
                               '  init) exit 0 ;;\n'
                               '  plan) for arg in "$@"; do [[ "$arg" == -out=* ]] && printf saved > "${arg#-out=}"; done; true ;;\n'
                               '  show) cat "$MOCK_FIXTURE" ;;\n'
                               '  apply) [[ -f "${@: -1}" ]] && [[ "$(cat "${@: -1}")" == saved ]] ;;\n'
                               'esac\n')
            command.chmod(0o700)
            calls = root / "calls"
            saved = root / "saved.tfplan"
            fixture = root / "valid-plan.json"
            fixture.write_text(json.dumps(VALID))
            var_file = root / "staging.tfvars"
            var_file.write_text('environment = "staging"\n')
            environment = {**os.environ, "PATH": f"{root}:{os.environ['PATH']}",
                           "MOCK_CALLS": str(calls),
                           "MOCK_FIXTURE": str(fixture),
                           "TF_BACKEND_BUCKET": "fixture-bucket"}
            workflow = ROOT.parent / "plan-apply.sh"
            base = ["bash", str(workflow), "--var-file", str(var_file)]
            for operation in ("plan", "apply"):
                result = subprocess.run(base + [operation, str(saved)],
                                        env=environment, capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(sum(line.startswith("show -json " + str(saved))
                                 for line in calls.read_text().splitlines()), 2)
            self.assertTrue(calls.read_text().splitlines()[-1].endswith(str(saved)))

            tampered = copy.deepcopy(VALID)
            resource(tampered, "hcloud_server.staging")["change"]["after"].update(
                user_data="#!/bin/bash\nexit 0\n")
            fixture.write_text(json.dumps(tampered))
            result = subprocess.run(base + ["apply", str(saved)],
                                    env=environment, capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Staging plan rejected", result.stderr)
            self.assertEqual(sum(line.startswith("apply ") for line in calls.read_text().splitlines()), 1)
            fixture.write_text(json.dumps(VALID))

            saved.write_text("substituted")
            result = subprocess.run(base + ["apply", str(saved)],
                                    env=environment, capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("identity changed", result.stderr)

            saved.unlink()
            saved.with_suffix(".tfplan.sha256").unlink()
            environment["MOCK_FIXTURE"] = str(ROOT / "fixtures/invalid-public-plan.json")
            result = subprocess.run(base + ["plan", str(saved)],
                                    env=environment, capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(saved.exists())
            self.assertFalse(saved.with_suffix(".tfplan.sha256").exists())


if __name__ == "__main__":
    unittest.main()
