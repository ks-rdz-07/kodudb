# KoduDB prod on hetzner. Replace the placeholders, then: terraform apply -var-file=envs/prod.tfvars
environment    = "prod"
location       = "fsn1"
server_type    = "cx42"
domain         = "example.com" # HTTPS on app./api./s3./storage.<domain>
kodudb_version = "0.3.2"
ssh_public_key = "ssh-ed25519 AAAA... replace with your public key"
admin_cidr     = "203.0.113.4/32" # your address, for SSH
