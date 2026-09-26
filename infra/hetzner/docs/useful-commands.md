ssh into 
```sh
ssh -i ~/.ssh/traderton_deploy_staging_key root@2.28.19.89 \
  'cd /opt/traderton/staging && docker compose --env-file .env.staging logs --tail=80 boundary'
```  