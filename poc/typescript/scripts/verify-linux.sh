#!/usr/bin/env bash
# Builds the Ubuntu 24.04 verification image and runs typecheck + tests + probe/doctor
# inside it, writing results into poc/typescript/results/ on the host. Run from the
# repository root (or anywhere - it cd's to the repo root itself):
#
#   bash poc/typescript/scripts/verify-linux.sh
#
# On Git Bash / MSYS, absolute host paths passed to `docker run -v` get path-mangled
# (e.g. "/out" becomes "C:/Program Files/Git/out"). MSYS_NO_PATHCONV=1 disables that
# translation for this script's docker invocations.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POC_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${POC_DIR}/../.." && pwd)"
RESULTS_DIR="${POC_DIR}/results"
IMAGE_TAG="hdo-poc-ubuntu:latest"

mkdir -p "${RESULTS_DIR}"

echo "==> Building ${IMAGE_TAG} from repository root context"
cd "${REPO_ROOT}"
docker build -f poc/typescript/scripts/Dockerfile.ubuntu -t "${IMAGE_TAG}" .

echo "==> Running typecheck + tests + probe + doctor inside ${IMAGE_TAG}"
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "${RESULTS_DIR}:/out" \
  "${IMAGE_TAG}" \
  bash -lc '
    set -euo pipefail
    npm ci
    echo "----- npm run typecheck -----"
    npm run typecheck
    echo "----- npm test -----"
    npm test 2>&1 | tee /out/ubuntu-test-output.txt
    echo "----- probe --json -----"
    node src/cli/main.ts probe --json | tee /out/ubuntu.json
    echo "----- doctor --json -----"
    node src/cli/main.ts doctor --json
  '

echo "==> Wrote ${RESULTS_DIR}/ubuntu.json and ${RESULTS_DIR}/ubuntu-test-output.txt"
