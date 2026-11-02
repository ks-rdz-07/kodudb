output "public_ip" {
  value = google_compute_address.kodudb.address
}

output "urls" {
  description = "Console, API and storage addresses."
  value       = { for k, v in module.kodudb.urls : k => replace(v, "HOST", google_compute_address.kodudb.address) }
}

output "sign_in" {
  description = "How to read the console sign-in printed on first start."
  value       = "ssh ubuntu@${google_compute_address.kodudb.address} 'cd /opt/kodudb && sudo docker compose logs api | grep -A3 sign-in'"
}
