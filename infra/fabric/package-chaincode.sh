#!/bin/sh
set -eu

input_dir=${1:?usage: package-chaincode.sh BUILT_DIR OUTPUT_PACKAGE}
output_file=${2:?usage: package-chaincode.sh BUILT_DIR OUTPUT_PACKAGE}

if [ ! -d "$input_dir" ]; then
  echo "built chaincode directory does not exist" >&2
  exit 2
fi
if ! command -v peer >/dev/null 2>&1; then
  echo "Hyperledger Fabric peer CLI is required for lifecycle packaging; build.mjs remains dependency-free" >&2
  exit 3
fi
mkdir -p "$(dirname "$output_file")"
peer lifecycle chaincode package "$output_file" --path "$input_dir" --lang node --label kcl_0.1.0
printf '%s\n' "$output_file"
