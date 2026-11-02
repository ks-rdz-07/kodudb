variable "environment" {
  description = "Environment name (dev, staging, prod); used in resource names."
  type        = string
}

variable "subscription_id" {
  description = "Azure subscription id."
  type        = string
}

variable "location" {
  description = "Azure region."
  type        = string
  default     = "eastus"
}

variable "vm_size" {
  description = "VM size (2 GB of memory or more)."
  type        = string
  default     = "Standard_B2s"
}

variable "disk_gb" {
  description = "OS disk size in GB (database, files and images)."
  type        = number
  default     = 32
}

variable "domain" {
  description = "Optional base domain for HTTPS (app., api., s3. and storage.<domain> must point at the public IP)."
  type        = string
  default     = ""
}

variable "kodudb_version" {
  description = "KoduDB image tag."
  type        = string
  default     = "0.2.0"
}

variable "ssh_public_key" {
  description = "Public key for SSH access as the ubuntu user."
  type        = string
}

variable "admin_cidr" {
  description = "Address range allowed to connect over SSH, e.g. 203.0.113.4/32."
  type        = string
}
