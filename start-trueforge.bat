@echo off
set NETWORK_POLICY_ENABLED=false
set OUTBOUND_URL_ALLOWED_HOSTS=["localhost","127.0.0.1"]
set MODEL_HTTP_MAX_RETRIES=5
set MODEL_HTTP_HEADERS_TIMEOUT_MS=60000
set MODEL_HTTP_CONNECT_TIMEOUT_MS=15000
echo Starting TrueForge with local network access enabled...
npx @truefoundry/trueforge@latest
