variable "environment" {
  description = "dev, staging or prod; selects deploy/helm/kodudb/values-<environment>.yaml."
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }
}

variable "kubeconfig" {
  description = "Path to the kubeconfig file."
  type        = string
  default     = "~/.kube/config"
}

variable "kube_context" {
  description = "Kubeconfig context of the target cluster (empty: current context)."
  type        = string
  default     = ""
}

variable "namespace" {
  description = "Namespace for the release."
  type        = string
  default     = "kodudb"
}

variable "kodudb_version" {
  description = "KoduDB image tag."
  type        = string
  default     = "0.3.1"
}

variable "domain" {
  description = "Base domain. When set, an ingress serves app., api., s3. and storage.<domain> (overrides the hosts in the values file)."
  type        = string
  default     = ""
}

variable "ingress_class" {
  description = "Ingress class name (e.g. nginx, traefik)."
  type        = string
  default     = "nginx"
}

variable "cluster_issuer" {
  description = "cert-manager ClusterIssuer for TLS certificates (empty: no annotation)."
  type        = string
  default     = "letsencrypt"
}

variable "external_database_url" {
  description = "Managed Postgres URL (postgres://user:password@host:5432/kodudb). Empty: run the bundled Postgres."
  type        = string
  default     = ""
  sensitive   = true
}
