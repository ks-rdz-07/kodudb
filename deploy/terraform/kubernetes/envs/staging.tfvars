# KoduDB staging: ingress with TLS from cert-manager.
environment    = "staging"
kube_context   = ""
kodudb_version = "0.2.0"
domain         = "staging.example.com"
ingress_class  = "nginx"
cluster_issuer = "letsencrypt"
