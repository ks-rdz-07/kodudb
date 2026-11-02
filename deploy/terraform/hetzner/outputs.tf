output "public_ip" {
  value = hcloud_primary_ip.kodudb.ip_address
}

output "urls" {
  description = "Console, API and storage addresses."
  value       = { for k, v in module.kodudb.urls : k => replace(v, "HOST", hcloud_primary_ip.kodudb.ip_address) }
}

output "sign_in" {
  description = "How to read the console sign-in printed on first start."
  value       = "ssh root@${hcloud_primary_ip.kodudb.ip_address} 'cd /opt/kodudb && docker compose logs api | grep -A3 sign-in'"
}
