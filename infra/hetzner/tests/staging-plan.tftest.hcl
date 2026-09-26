mock_provider "hcloud" {}

variables {
  environment         = "staging"
  server_type         = "cx23"
  ssh_public_key      = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureOnlyNotARealKey fixture"
  location            = "fsn1"
  api_hostname        = "api.staging.traderton.com"
  site_hostname       = "staging.traderton.com"
  data_volume_size_gb = 50
}

run "serves_tls_over_80_443_and_opens_ssh_over_key_auth" {
  command = plan

  assert {
    condition     = length([for rule in hcloud_firewall.staging.rule : rule if rule.port == "80" && rule.source_ips == toset(["0.0.0.0/0", "::/0"])]) == 1
    error_message = "Caddy HTTP ingress must allow 80 from anywhere."
  }
  assert {
    condition     = length([for rule in hcloud_firewall.staging.rule : rule if rule.port == "443" && rule.source_ips == toset(["0.0.0.0/0", "::/0"])]) == 1
    error_message = "Caddy HTTPS ingress must allow 443 from anywhere."
  }
  assert {
    condition     = length([for rule in hcloud_firewall.staging.rule : rule if rule.port == "22" && rule.source_ips == toset(["0.0.0.0/0", "::/0"])]) == 1
    error_message = "SSH ingress must be open (key-auth gated), matching the herobids convention."
  }
  assert {
    condition     = hcloud_server.staging.location == var.location
    error_message = "Staging server location must match the configured location."
  }
  assert {
    condition     = hcloud_server.staging.server_type == var.server_type
    error_message = "Staging server type must match the configured type."
  }
}
