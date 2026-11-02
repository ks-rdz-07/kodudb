# KoduDB on one DigitalOcean Droplet (Ubuntu 24.04) running the Compose stack.
#   export DIGITALOCEAN_TOKEN=...   then: terraform init && terraform apply -var-file=envs/dev.tfvars

terraform {
  required_version = ">= 1.6"
  required_providers {
    digitalocean = { source = "digitalocean/digitalocean", version = "~> 2.0" }
  }
}

module "kodudb" {
  source         = "../modules/compose-host"
  domain         = var.domain
  kodudb_version = var.kodudb_version
}

resource "digitalocean_ssh_key" "admin" {
  name       = "kodudb-${var.environment}"
  public_key = var.ssh_public_key
}

resource "digitalocean_droplet" "kodudb" {
  name       = "kodudb-${var.environment}"
  region     = var.region
  size       = var.size
  image      = "ubuntu-24-04-x64"
  ssh_keys   = [digitalocean_ssh_key.admin.fingerprint]
  user_data  = module.kodudb.user_data
  monitoring = true
  tags       = ["kodudb", var.environment]
}

resource "digitalocean_reserved_ip" "kodudb" {
  region     = var.region
  droplet_id = digitalocean_droplet.kodudb.id
}

resource "digitalocean_firewall" "kodudb" {
  name        = "kodudb-${var.environment}"
  droplet_ids = [digitalocean_droplet.kodudb.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = [var.admin_cidr]
  }
  dynamic "inbound_rule" {
    for_each = module.kodudb.ports
    content {
      protocol         = "tcp"
      port_range       = tostring(inbound_rule.value)
      source_addresses = ["0.0.0.0/0", "::/0"]
    }
  }
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}
