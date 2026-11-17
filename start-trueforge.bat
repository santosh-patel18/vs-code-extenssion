@echo off
set NETWORK_POLICY_ENABLED=false
set OUTBOUND_URL_ALLOWED_HOSTS=["localhost","127.0.0.1"]
echo Starting TrueForge with local network access enabled...
npx @truefoundry/trueforge@latest
