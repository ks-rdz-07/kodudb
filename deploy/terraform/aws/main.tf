# KoduDB on one AWS EC2 instance (Ubuntu 24.04) running the Compose stack.
#   terraform init && terraform apply -var-file=envs/dev.tfvars

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

provider "aws" {
  region = var.region
}

module "kodudb" {
  source         = "../modules/compose-host"
  domain         = var.domain
  kodudb_version = var.kodudb_version
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
}

resource "aws_key_pair" "admin" {
  key_name   = "kodudb-${var.environment}"
  public_key = var.ssh_public_key
}

resource "aws_security_group" "kodudb" {
  name        = "kodudb-${var.environment}"
  description = "KoduDB ${var.environment}"

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }
  dynamic "ingress" {
    for_each = module.kodudb.ports
    content {
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "kodudb" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = aws_key_pair.admin.key_name
  vpc_security_group_ids = [aws_security_group.kodudb.id]
  user_data              = module.kodudb.user_data

  root_block_device {
    volume_size = var.disk_gb
    volume_type = "gp3"
    encrypted   = true
  }
  metadata_options {
    http_tokens = "required" # IMDSv2 only
  }
  tags = { Name = "kodudb-${var.environment}", Environment = var.environment }
}

resource "aws_eip" "kodudb" {
  instance = aws_instance.kodudb.id
  tags     = { Name = "kodudb-${var.environment}" }
}
