# Cloud-init for a single Linux VM that runs KoduDB from deploy/compose (Postgres, API, console, RustFS).
# Secrets are generated on the server at first boot, so they never appear in Terraform state.

terraform {
  required_version = ">= 1.6"
}

variable "domain" {
  description = "Optional base domain. With it, Caddy serves HTTPS on app., api., s3. and storage.<domain> (point those DNS records at the server)."
  type        = string
  default     = ""
}

variable "kodudb_version" {
  description = "KoduDB image tag."
  type        = string
  default     = "0.3.2"
}

variable "image_registry" {
  description = "Registry and namespace of the KoduDB images."
  type        = string
  default     = "docker.io/kns777"
}

variable "rustfs_version" {
  description = "RustFS image tag for file storage."
  type        = string
  default     = "1.0.4"
}

variable "install_dir" {
  description = "Where the Compose project is written on the server."
  type        = string
  default     = "/opt/kodudb"
}

locals {
  compose_dir = "${path.module}/../../../compose"
  tls         = var.domain != ""
  settings = join("\n", compact([
    "KODUDB_IMAGE_REGISTRY=${var.image_registry}",
    "KODUDB_VERSION=${var.kodudb_version}",
    "RUSTFS_VERSION=${var.rustfs_version}",
  ]))
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    install_dir  = var.install_dir
    compose_b64  = filebase64("${local.compose_dir}/compose.yml")
    caddy_b64    = filebase64("${local.compose_dir}/Caddyfile")
    init_env_b64 = filebase64("${local.compose_dir}/init-env.sh")
    settings_b64 = base64encode("${local.settings}\n")
    domain       = var.domain
    profile      = local.tls ? "--profile tls" : ""
  })
}

output "user_data" {
  description = "Cloud-init document for the VM."
  value       = local.user_data
}

output "ports" {
  description = "TCP ports the VM must accept from the internet."
  value       = local.tls ? [80, 443] : [3100, 8787, 9000, 9001]
}

output "urls" {
  description = "Addresses of the console, API and storage, given the server address (replace HOST)."
  value = local.tls ? {
    console         = "https://app.${var.domain}"
    api             = "https://api.${var.domain}"
    s3              = "https://s3.${var.domain}"
    storage_console = "https://storage.${var.domain}/rustfs/console/"
    } : {
    console         = "http://HOST:3100"
    api             = "http://HOST:8787"
    s3              = "http://HOST:9000"
    storage_console = "http://HOST:9001/rustfs/console/"
  }
}
