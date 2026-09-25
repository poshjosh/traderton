terraform {
  # S3-compatible remote backend. bucket/region/key/dynamodb_table are supplied
  # at init time via -backend-config by plan-apply.sh, so the key is per-environment:
  #   staging:     key = "traderton/staging/terraform.tfstate"
  #   production:  key = "traderton/production/terraform.tfstate"
  backend "s3" {
    use_path_style              = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
  }
}