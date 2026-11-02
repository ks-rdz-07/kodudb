# KoduDB on one Hetzner Cloud server (Ubuntu 24.04) running the Compose stack.
#   export HCLOUD_TOKEN=...   then: terraform init && terraform apply -var-file=envs/dev.tfvars

terraform {
  required_version = ">= 1.6"
  required_providers {
    hcloud = { source = "hetznercloud/hcloud", version = "~> 1.50" }
  }
}

module "kodudb" {
  source         = "../modules/compose-host"
  domain         = var.domain
  kodudb_version = var.kodudb_version
}

resource "hcloud_ssh_key" "admin" {
  name       = "kodudb-${var.environment}"
  public_key = var.ssh_public_key
}

resource "hcloud_firewall" "kodudb" {
  name = "kodudb-${var.environment}"
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = [var.admin_cidr]
  }
  dynamic "rule" {
    for_each = module.kodudb.ports
    content {
      direction  = "in"
      protocol   = "tcp"
      port       = tostring(rule.value)
      source_ips = ["0.0.0.0/0", "::/0"]
    }
  }
}

resource "hcloud_primary_ip" "kodudb" {
  name        = "kodudb-${var.environment}"
  type        = "ipv4"
  location    = var.location
  auto_delete = false
}

resource "hcloud_server" "kodudb" {
  name         = "kodudb-${var.environment}"
  server_type  = var.server_type
  image        = "ubuntu-24.04"
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.kodudb.id]
  user_data    = module.kodudb.user_data
  labels       = { app = "kodudb", environment = var.environment }

  public_net {
    ipv4 = hcloud_primary_ip.kodudb.id
  }
}
