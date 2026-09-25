#!/usr/bin/env python3
"""Reject a saved staging plan that differs from the reviewed topology.

Public/independent model: Traderton owns its own VM and exposes the boundary
over the public interface. There is no Herobids network handoff to consume, so
the guard validates the plan against the standalone variables only.
"""

import base64
import hashlib
import ipaddress
import json
import re
import sys
from pathlib import Path


RESOURCES = {
    "hcloud_ssh_key.staging": "hcloud_ssh_key",
    "hcloud_firewall.staging": "hcloud_firewall",
    "hcloud_server.staging": "hcloud_server",
    "hcloud_volume.data": "hcloud_volume",
    "hcloud_volume_attachment.data": "hcloud_volume_attachment",
}
REFERENCES = {
    ("hcloud_server.staging", "firewall_ids"): "hcloud_firewall.staging.id",
    ("hcloud_server.staging", "ssh_keys"): "hcloud_ssh_key.staging.id",
    ("hcloud_volume_attachment.data", "volume_id"): "hcloud_volume.data.id",
    ("hcloud_volume_attachment.data", "server_id"): "hcloud_server.staging.id",
}
TEMPLATE = Path(__file__).resolve().parent.parent / "cloud-init.sh.tftpl"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def expected_user_data():
    template = TEMPLATE.read_text(encoding="utf-8")
    require("%{" not in template and "${" not in template, "unsupported cloud-init template")
    # The `user_data` attribute is sensitive: `terraform show -json` emits its
    # base64-encoded SHA-1 digest rather than the plaintext. Expect that digest.
    return base64.b64encode(hashlib.sha1(template.encode("utf-8")).digest()).decode("ascii")


def check(plan):
    require(plan.get("format_version", "").split(".")[0] == "1", "unsupported plan format")
    require(plan.get("errored") is False and plan.get("complete") is True, "incomplete plan")
    variables = plan["variables"]
    environment = variables["environment"]["value"]
    require(isinstance(environment, str) and re.fullmatch(r"[a-z0-9_-]+", environment),
            "invalid environment")
    require(isinstance(variables["api_hostname"]["value"], str) and variables["api_hostname"]["value"],
            "missing api hostname")
    require(isinstance(variables["site_hostname"]["value"], str) and variables["site_hostname"]["value"],
            "missing site hostname")
    ssh_sources = set(variables["ssh_source_cidrs"]["value"])
    require(ssh_sources, "missing ingress")
    require(all(ipaddress.ip_network(cidr, strict=True).version == 4 and
                ipaddress.ip_network(cidr, strict=True).prefixlen == 32
                for cidr in ssh_sources), "public SSH ingress")

    changes = plan["resource_changes"]
    require(len(changes) == len(RESOURCES), "unexpected resource count")
    resources = {}
    for change in changes:
        address = change["address"]
        require(address in RESOURCES and change["type"] == RESOURCES[address] and
                change["mode"] == "managed" and address not in resources, "unexpected resource")
        require(change["change"]["actions"] in (["create"], ["read"], ["no-op"]),
                "non-allowed plan action")
        resources[address] = change["change"]["after"]

    config = {resource["address"]: resource for resource in
              plan["configuration"]["root_module"]["resources"]}
    require(set(config) == set(RESOURCES), "unexpected configured resource")
    for (address, attribute), reference in REFERENCES.items():
        require(reference in config[address]["expressions"][attribute]["references"],
                "missing attachment reference")

    firewall = resources["hcloud_firewall.staging"]
    rules = firewall["rule"]
    public = {"0.0.0.0/0", "::/0"}
    expected_rules = [
        ("22", ssh_sources),
        ("80", public),
        ("443", public),
    ]
    require(firewall["name"] == f"traderton-{environment}" and len(rules) == 3,
            "unexpected firewall")
    for port, sources in expected_rules:
        require(sum(rule["direction"] == "in" and rule["protocol"] == "tcp" and
                    str(rule["port"]) == port and set(rule["source_ips"]) == sources
                    for rule in rules) == 1, "unexpected ingress rule")

    server = resources["hcloud_server.staging"]
    require(server["name"] == f"traderton-{environment}" and server["image"] == "ubuntu-24.04" and
            server["location"] == variables["location"]["value"] and
            server["server_type"] == variables["server_type"]["value"], "wrong staging server")
    require(server["user_data"] == expected_user_data(), "wrong server user_data")
    volume = resources["hcloud_volume.data"]
    require(volume["name"] == f"traderton-{environment}-data" and volume["format"] == "ext4" and
            volume["location"] == variables["location"]["value"] and
            volume["size"] == variables["data_volume_size_gb"]["value"], "wrong data volume")
    require(resources["hcloud_volume_attachment.data"]["automount"] is False,
            "unexpected volume mount")
    public_key = variables["ssh_public_key"]["value"]
    require(isinstance(public_key, str) and
            re.fullmatch(r"(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}(?: [^\r\n]+)?", public_key),
            "invalid SSH public key input")
    ssh_key = resources["hcloud_ssh_key.staging"]
    require(ssh_key["name"] == f"traderton-{environment}" and ssh_key["public_key"] == public_key,
            "wrong SSH key")


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2, "usage: guard-plan.py <saved-plan.json>")
        with open(sys.argv[1], encoding="utf-8") as file:
            plan = json.load(file)
        check(plan)
    except (ValueError, KeyError, TypeError, OSError, IndexError) as error:
        print(f"Staging plan rejected: {error}", file=sys.stderr)
        sys.exit(1)
    print("Staging plan approved for review")