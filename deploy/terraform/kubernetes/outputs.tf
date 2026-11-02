output "release" {
  value = "${helm_release.kodudb.namespace}/${helm_release.kodudb.name} (${helm_release.kodudb.status})"
}

output "sign_in" {
  description = "How to read the console sign-in printed on first start."
  value       = "kubectl -n ${helm_release.kodudb.namespace} logs deploy/kodudb-api | grep -A3 sign-in"
}
