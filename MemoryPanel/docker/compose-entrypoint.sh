#!/bin/sh
# Runtime entrypoint used by the repository-root Compose deployment.
#
# The Panel requires an instance registry containing the Gateway bearer token.
# Generate that registry inside the container from Compose-provided environment
# variables so no credential-bearing JSON file needs to be created or mounted
# on the Linux host.
set -eu

: "${TDAI_GATEWAY_API_KEY:?TDAI_GATEWAY_API_KEY must be set}"
: "${TDAI_SERVICE_ID:?TDAI_SERVICE_ID must be set}"
: "${TDAI_PANEL_INSTANCE_NAME:?TDAI_PANEL_INSTANCE_NAME must be set}"
: "${TDAI_PANEL_GATEWAY_ENDPOINT:?TDAI_PANEL_GATEWAY_ENDPOINT must be set}"
: "${TDAI_PANEL_PROXY_ENDPOINT:?TDAI_PANEL_PROXY_ENDPOINT must be set}"

export METADATA_INSTANCES_CONFIG="${METADATA_INSTANCES_CONFIG:-/run/tdai-panel/metadata-instances.json}"

node --input-type=module <<'NODE'
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const configPath = process.env.METADATA_INSTANCES_CONFIG;
const registry = {
  instances: [
    {
      id: process.env.TDAI_SERVICE_ID,
      name: process.env.TDAI_PANEL_INSTANCE_NAME,
      gateway_endpoint: process.env.TDAI_PANEL_GATEWAY_ENDPOINT,
      proxy_endpoint: process.env.TDAI_PANEL_PROXY_ENDPOINT,
      api_key: process.env.TDAI_GATEWAY_API_KEY,
    },
  ],
};

mkdirSync(dirname(configPath), { recursive: true });
writeFileSync(configPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
NODE

exec node --import tsx/esm src/index.ts
