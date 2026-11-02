# KoduDB on one Azure Linux VM (Ubuntu 24.04) running the Compose stack.
#   terraform init && terraform apply -var-file=envs/dev.tfvars

terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

module "kodudb" {
  source         = "../modules/compose-host"
  domain         = var.domain
  kodudb_version = var.kodudb_version
}

locals {
  name = "kodudb-${var.environment}"
  tags = { environment = var.environment }
}

resource "azurerm_resource_group" "kodudb" {
  name     = local.name
  location = var.location
  tags     = local.tags
}

resource "azurerm_virtual_network" "kodudb" {
  name                = local.name
  address_space       = ["10.40.0.0/16"]
  location            = azurerm_resource_group.kodudb.location
  resource_group_name = azurerm_resource_group.kodudb.name
}

resource "azurerm_subnet" "kodudb" {
  name                 = local.name
  resource_group_name  = azurerm_resource_group.kodudb.name
  virtual_network_name = azurerm_virtual_network.kodudb.name
  address_prefixes     = ["10.40.1.0/24"]
}

resource "azurerm_public_ip" "kodudb" {
  name                = local.name
  location            = azurerm_resource_group.kodudb.location
  resource_group_name = azurerm_resource_group.kodudb.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

resource "azurerm_network_security_group" "kodudb" {
  name                = local.name
  location            = azurerm_resource_group.kodudb.location
  resource_group_name = azurerm_resource_group.kodudb.name

  security_rule {
    name                       = "ssh"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = var.admin_cidr
    destination_address_prefix = "*"
  }
  security_rule {
    name                       = "web"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_ranges    = [for p in module.kodudb.ports : tostring(p)]
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_network_interface" "kodudb" {
  name                = local.name
  location            = azurerm_resource_group.kodudb.location
  resource_group_name = azurerm_resource_group.kodudb.name
  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.kodudb.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.kodudb.id
  }
}

resource "azurerm_network_interface_security_group_association" "kodudb" {
  network_interface_id      = azurerm_network_interface.kodudb.id
  network_security_group_id = azurerm_network_security_group.kodudb.id
}

resource "azurerm_linux_virtual_machine" "kodudb" {
  name                  = local.name
  location              = azurerm_resource_group.kodudb.location
  resource_group_name   = azurerm_resource_group.kodudb.name
  size                  = var.vm_size
  admin_username        = "ubuntu"
  network_interface_ids = [azurerm_network_interface.kodudb.id]
  custom_data           = base64encode(module.kodudb.user_data)
  tags                  = local.tags

  admin_ssh_key {
    username   = "ubuntu"
    public_key = var.ssh_public_key
  }
  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = var.disk_gb
  }
  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }
}
