# KoduDB on one Google Compute Engine VM (Ubuntu 24.04) running the Compose stack.
#   terraform init && terraform apply -var-file=envs/dev.tfvars

terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
}

provider "google" {
  project = var.project
  region  = var.region
  zone    = var.zone
}

module "kodudb" {
  source         = "../modules/compose-host"
  domain         = var.domain
  kodudb_version = var.kodudb_version
}

resource "google_compute_address" "kodudb" {
  name = "kodudb-${var.environment}"
}

resource "google_compute_firewall" "ssh" {
  name          = "kodudb-${var.environment}-ssh"
  network       = "default"
  source_ranges = [var.admin_cidr]
  target_tags   = ["kodudb-${var.environment}"]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_compute_firewall" "web" {
  name          = "kodudb-${var.environment}-web"
  network       = "default"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["kodudb-${var.environment}"]
  allow {
    protocol = "tcp"
    ports    = [for p in module.kodudb.ports : tostring(p)]
  }
}

resource "google_compute_instance" "kodudb" {
  name         = "kodudb-${var.environment}"
  machine_type = var.machine_type
  tags         = ["kodudb-${var.environment}"]
  labels       = { environment = var.environment }

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = var.disk_gb
      type  = "pd-balanced"
    }
  }
  network_interface {
    network = "default"
    access_config {
      nat_ip = google_compute_address.kodudb.address
    }
  }
  metadata = {
    user-data = module.kodudb.user_data
    ssh-keys  = "ubuntu:${var.ssh_public_key}"
  }
  shielded_instance_config {
    enable_secure_boot = true
  }
}
