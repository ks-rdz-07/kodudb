output "public_ip" {
  value = aws_eip.kodudb.public_ip
}

output "urls" {
  description = "Console, API and storage addresses."
  value       = { for k, v in module.kodudb.urls : k => replace(v, "HOST", aws_eip.kodudb.public_ip) }
}

output "sign_in" {
  description = "How to read the console sign-in printed on first start."
  value       = "ssh ubuntu@${aws_eip.kodudb.public_ip} 'cd /opt/kodudb && sudo docker compose logs api | grep -A3 sign-in'"
}
