# KoduDB dev on hetzner. Replace the placeholders, then: terraform apply -var-file=envs/dev.tfvars
environment    = "dev"
location       = "fsn1"
server_type    = "cx22"
domain         = "" # empty: plain HTTP on ports 3100/8787/9000/9001
kodudb_version = "0.3.1"
ssh_public_key = "ssh-ed25519 AAAA... replace with your public key"
admin_cidr     = "203.0.113.4/32" # your address, for SSH
