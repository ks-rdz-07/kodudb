# KoduDB staging: ingress with TLS from cert-manager.
environment    = "staging"
kube_context   = ""
kodudb_version = "0.3.2"
domain         = "staging.example.com"
ingress_class  = "nginx"
cluster_issuer = "letsencrypt"
