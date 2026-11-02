variable "environment" {
  description = "Environment name (dev, staging, prod); used in resource names."
  type        = string
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type (2 GB of memory or more)."
  type        = string
  default     = "t3.small"
}

variable "disk_gb" {
  description = "Root disk size in GB (database, files and images)."
  type        = number
  default     = 30
}

variable "domain" {
  description = "Optional base domain for HTTPS (app., api., s3. and storage.<domain> must point at the Elastic IP)."
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
