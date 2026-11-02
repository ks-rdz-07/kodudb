# terraform test (from modules/compose-host): checks the cloud-init document without any cloud provider.

run "plain_http_without_domain" {
  command = plan

  assert {
    condition     = jsonencode(output.ports) == jsonencode([3100, 8787, 9000, 9001])
    error_message = "Without a domain the VM must expose the API, console and storage ports."
  }
  assert {
    condition     = startswith(output.user_data, "#cloud-config\n")
    error_message = "user_data must be a cloud-config document."
  }
  assert {
    condition     = strcontains(output.user_data, "content: ${filebase64("${path.module}/../../../compose/compose.yml")}")
    error_message = "compose.yml must be embedded unchanged."
  }
  assert {
    condition     = strcontains(output.user_data, "docker compose  up -d")
    error_message = "Without a domain, Compose starts without the tls profile."
  }
  assert {
    condition     = strcontains(output.user_data, "k=$${l%%=*}")
    error_message = "Shell parameter expansion in the settings merge must survive template rendering."
  }
  assert {
    condition     = output.urls.console == "http://HOST:3100"
    error_message = "Console URL placeholder is wrong."
  }
}

run "https_with_domain" {
  command = plan
  variables {
    domain         = "example.com"
    kodudb_version = "9.9.9"
  }

  assert {
    condition     = jsonencode(output.ports) == jsonencode([80, 443])
    error_message = "With a domain only HTTP and HTTPS are exposed (Caddy)."
  }
  assert {
    condition     = strcontains(output.user_data, "docker compose --profile tls up -d")
    error_message = "With a domain, Compose starts with the tls profile."
  }
  assert {
    condition     = strcontains(output.user_data, "./init-env.sh example.com")
    error_message = "The domain must be passed to init-env.sh."
  }
  assert {
    condition     = strcontains(output.user_data, base64encode("KODUDB_IMAGE_REGISTRY=docker.io/kns777\nKODUDB_VERSION=9.9.9\nRUSTFS_VERSION=1.0.4\n"))
    error_message = "Image settings must reach the server."
  }
  assert {
    condition     = output.urls.api == "https://api.example.com"
    error_message = "API URL must use the domain."
  }
}
