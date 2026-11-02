# Installs KoduDB into an existing Kubernetes cluster (EKS, GKE, AKS, DigitalOcean, k3s...) with the Helm chart
# in deploy/helm/kodudb.
#   terraform init && terraform apply -var-file=envs/dev.tfvars

terraform {
  required_version = ">= 1.6"
  required_providers {
    helm = { source = "hashicorp/helm", version = "~> 3.0" }
  }
}

provider "helm" {
  kubernetes = {
    config_path    = var.kubeconfig
    config_context = var.kube_context
  }
}

locals {
  chart_dir = "${path.module}/../../helm/kodudb"
  ingress = var.domain == "" ? {} : {
    ingress = {
      enabled     = true
      className   = var.ingress_class
      annotations = var.cluster_issuer == "" ? {} : { "cert-manager.io/cluster-issuer" = var.cluster_issuer }
      hosts = {
        console        = "app.${var.domain}"
        api            = "api.${var.domain}"
        s3             = "s3.${var.domain}"
        storageConsole = "storage.${var.domain}"
      }
      tls = [{
        secretName = "kodudb-${var.environment}-tls"
        hosts      = ["app.${var.domain}", "api.${var.domain}", "s3.${var.domain}", "storage.${var.domain}"]
      }]
    }
  }
  database = var.external_database_url == "" ? {} : {
    postgres         = { enabled = false }
    externalDatabase = { url = var.external_database_url }
  }
}

resource "helm_release" "kodudb" {
  name             = "kodudb"
  namespace        = var.namespace
  create_namespace = true
  chart            = local.chart_dir
  wait             = true
  timeout          = 600

  values = [
    file("${local.chart_dir}/values-${var.environment}.yaml"),
    yamlencode(merge(
      { image = { tag = var.kodudb_version } },
      local.ingress,
      local.database,
    )),
  ]
}
