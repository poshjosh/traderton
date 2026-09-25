terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.54"
    }
  }
}

provider "hcloud" {}

variable "environment" {
  type        = string
  description = "Environment name (e.g. staging, production). Selects <env>.tfvars and the backend state key, and labels all resources."
}

variable "location" {
  type        = string
  description = "Hetzner datacenter location for the Traderton VM."
  default     = "fsn1"
}

variable "server_type" {
  type        = string
  description = "VM type; choose after reviewing capacity."
  default     = "cx23"
}

variable "ssh_public_key" {
  type        = string
  description = "Public SSH key for the operator."
  sensitive   = true
}

variable "ssh_source_cidrs" {
  type        = set(string)
  description = "Individual operator IPv4 SSH ingress addresses (/32 only)."
  validation {
    condition     = length(var.ssh_source_cidrs) > 0 && alltrue([for cidr in var.ssh_source_cidrs : can(cidrnetmask(cidr)) && try(tonumber(split("/", cidr)[1]) == 32, false)])
    error_message = "Supply individual operator IPv4 SSH addresses as /32 CIDRs."
  }
}

variable "api_hostname" {
  type        = string
  description = "Public hostname for the Traderton API (execution endpoint, TLS-terminated by Caddy). Set per environment in <env>.tfvars."
}

variable "site_hostname" {
  type        = string
  description = "Public hostname for the human-facing site (frontend, later). Set per environment in <env>.tfvars."
}

variable "data_volume_size_gb" {
  type        = number
  description = "Persistent Postgres and Redis volume size in GiB."
  default     = 50
  validation {
    condition     = var.data_volume_size_gb >= 10
    error_message = "data_volume_size_gb must be at least 10 GiB."
  }
}

resource "hcloud_ssh_key" "staging" {
  name       = "traderton-${var.environment}"
  public_key = var.ssh_public_key
}

resource "hcloud_firewall" "staging" {
  name = "traderton-${var.environment}"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.ssh_source_cidrs
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  labels = { environment = var.environment, app = "traderton" }
}

resource "hcloud_server" "staging" {
  name         = "traderton-${var.environment}"
  server_type  = var.server_type
  image        = "ubuntu-24.04"
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.staging.id]
  firewall_ids = [hcloud_firewall.staging.id]
  user_data    = templatefile("${path.module}/cloud-init.sh.tftpl", {})
  labels       = { environment = var.environment, app = "traderton" }
}

resource "hcloud_volume" "data" {
  name     = "traderton-${var.environment}-data"
  size     = var.data_volume_size_gb
  location = var.location
  format   = "ext4"
  labels   = { environment = var.environment, app = "traderton" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "hcloud_volume_attachment" "data" {
  volume_id = hcloud_volume.data.id
  server_id = hcloud_server.staging.id
  automount = false
}

output "public_ip" {
  value       = hcloud_server.staging.ipv4_address
  description = "Public IPv4 of the Traderton server. Point the api/site DNS A records here."
}

output "api_url" {
  value       = "https://${var.api_hostname}"
  description = "TLS API endpoint Herobids API/worker/agents point TRADERTON_BOUNDARY_URL at. Caddy terminates TLS and proxies to the boundary on the compose network; HMAC authenticates every call."
}

output "site_url" {
  value       = "https://${var.site_hostname}"
  description = "Public site endpoint (frontend, later)."
}

output "data_volume_id" {
  value = hcloud_volume.data.id
}