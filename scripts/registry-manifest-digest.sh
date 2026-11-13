#!/usr/bin/env bash
set -euo pipefail

authfile="$1"
remote="$2"
manifest_file="$3"
skopeo inspect --authfile "$authfile" --raw "$remote" | tee "$manifest_file" | sha256sum | cut -d' ' -f1
