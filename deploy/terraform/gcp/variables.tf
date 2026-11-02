variable "environment" {
  description = "Environment name (dev, staging, prod); used in resource names."
  type        = string
}

variable "project" {
  description = "Google Cloud project id."
  type        = string
}

variable "region" {
  description = "Region."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "Zone."
  type        = string
  default     = "us-central1-a"
}

variable "machine_type" {
  description = "Machine type (2 GB of memory or more)."
  type        = string
  default     = "e2-small"
}

variable "disk_gb" {
  description = "Boot disk size in GB (database, files and images)."
  type        = number
  default     = 30
}

variable "domain" {
  description = "Optional base domain for HTTPS (app., api., s3. and storage.<domain> must point at the static IP)."
  type        = string
  default     = ""
}

variable "kodudb_version" {
  description = "KoduDB image tag."
  type        = string
  default     = "0.3.2"
}

variable "ssh_public_key" {
  description = "Public key for SSH access as the ubuntu user."
  type        = string
}

variable "admin_cidr" {
  description = "Address range allowed to connect over SSH, e.g. 203.0.113.4/32."
  type        = string
}
