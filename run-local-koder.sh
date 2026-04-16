#!/usr/bin/env bash

# FILE: run-local-koder.sh
# Purpose: Preferred Koder wrapper for the legacy local launcher script.
# Layer: developer utility
# Exports: none
# Depends on: ./run-local-remodex.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/run-local-remodex.sh" "$@"
