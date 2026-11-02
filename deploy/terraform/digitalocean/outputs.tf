output "public_ip" {
  value = digitalocean_reserved_ip.kodudb.ip_address
}

output "urls" {
  description = "Console, API and storage addresses."
  value       = { for k, v in module.kodudb.urls : k => replace(v, "HOST", digitalocean_reserved_ip.kodudb.ip_address) }
}

output "sign_in" {
  description = "How to read the console sign-in printed on first start."
  value       = "ssh root@${digitalocean_reserved_ip.kodudb.ip_address} 'cd /opt/kodudb && docker compose logs api | grep -A3 sign-in'"
}
