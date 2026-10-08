#!/usr/bin/env bash
# Runs Docker Compose with this installation's settings, for example:
#   sudo ./deploy/compose.sh ps -a
#   sudo ./deploy/compose.sh logs --tail=100 server
#
# With CIRCLUS_IMAGE_TAG set in deploy/.env, this uses the published images:
#   docker compose --env-file deploy/.env -f compose.yaml -f compose.prebuilt.yaml \
#     --profile local-turn ARGS...
# With CIRCLUS_IMAGE_TAG empty, it uses images built from this checkout:
#   docker compose --env-file deploy/.env -f compose.yaml --profile local-turn ARGS...
#
# The full command is printed before it runs.
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
cd "$repo_dir"

env_file="${CIRCLUS_ENV_FILE:-deploy/.env}"
if [[ ! -f "$env_file" ]]; then
  echo "Deployment settings not found: $env_file" >&2
  echo "Copy deploy/.env.example to deploy/.env and edit it first." >&2
  exit 1
fi
if [[ "$#" -eq 0 ]]; then
  echo "Usage: $0 COMPOSE_COMMAND [ARGS...]   (for example: $0 ps -a)" >&2
  exit 1
fi

# Like Compose, a value already set in the environment takes precedence.
if [[ -n "${CIRCLUS_IMAGE_TAG+set}" ]]; then
  image_tag="$CIRCLUS_IMAGE_TAG"
else
  image_tag=$(awk '
    index($0, "CIRCLUS_IMAGE_TAG=") == 1 { value = substr($0, 19) }
    END { print value }
  ' "$env_file")
  image_tag="${image_tag%$'\r'}"
  image_tag="${image_tag#\"}" && image_tag="${image_tag%\"}"
  image_tag="${image_tag#\'}" && image_tag="${image_tag%\'}"
fi

compose=(docker compose --env-file "$env_file" -f compose.yaml)
if [[ -n "$image_tag" ]]; then
  compose+=(-f compose.prebuilt.yaml)
  # Compose files, migrations and images must come from the same release.
  case "$1" in
    up|pull|create|run)
      if [[ -d .git ]] && command -v git >/dev/null 2>&1; then
        checkout_tags=$(git -c safe.directory="$repo_dir" tag --points-at HEAD)
        if ! grep -Fxq -- "$image_tag" <<<"$checkout_tags"; then
          echo "CIRCLUS_IMAGE_TAG=$image_tag does not match the checked-out code." >&2
          echo "Run: git fetch --tags && git switch --detach $image_tag" >&2
          echo "or set CIRCLUS_IMAGE_TAG in $env_file to the checked-out release tag." >&2
          exit 1
        fi
      fi
      ;;
  esac
  echo "Using published images $image_tag." >&2
else
  echo "CIRCLUS_IMAGE_TAG is empty: using images built from source." >&2
fi
compose+=(--profile local-turn "$@")

printf '+' >&2
printf ' %q' "${compose[@]}" >&2
printf '\n' >&2
exec "${compose[@]}"
