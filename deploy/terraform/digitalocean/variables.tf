variable "environment" {
  description = "Environment name (dev, staging, prod); used in resource names."
  type        = string
}

variable "region" {
  description = "DigitalOcean region slug."
  type        = string
  default     = "nyc3"
}

variable "size" {
  description = "Droplet size slug (2 GB of memory or more)."
  type        = string
  default     = "s-1vcpu-2gb"
}

variable "domain" {
  description = "Optional base domain for HTTPS (app., api., s3. and storage.<domain> must point at the reserved IP)."
  type        = string
  default     = ""
}

variable "kodudb_version" {
  description = "KoduDB image tag."
  type        = string
  default     = "0.2.0"
}

variable "ssh_public_key" {
  description = "Public key for SSH access as root."
  type        = string
}

variable "admin_cidr" {
  description = "Address range allowed to connect over SSH, e.g. 203.0.113.4/32."
  type        = string
}
