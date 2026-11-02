# KoduDB prod: ingress with TLS; set external_database_url (or TF_VAR_external_database_url) for a managed database.
environment    = "prod"
kube_context   = ""
kodudb_version = "0.3.0"
domain         = "example.com"
ingress_class  = "nginx"
cluster_issuer = "letsencrypt"
