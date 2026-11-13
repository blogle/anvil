#!/usr/bin/env bash
set -euo pipefail

config_file="${1:?usage: image-content-identity.sh CONFIG.json < manifest.json}"

# Check that manifest rewriting/compression did not change the image config.
# Config JSON comes from skopeo inspect --config, not from an untrusted
# descriptor lookup. Sorting keys makes object key order irrelevant while
# preserving every config field in the identity.
jq -cSe --slurpfile config "$config_file" '
  def descriptor($types):
    (type == "object") and
    ((keys - ["mediaType", "digest", "size", "annotations", "urls", "data"]) | length == 0) and
    (.mediaType | type == "string" and IN($types[])) and
    (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$")) and
    (.size | type == "number" and floor == . and . >= 0) and
    (if has("annotations") then (.annotations | type == "object") else true end) and
    (if has("urls") then (.urls | type == "array" and all(.[]; type == "string")) else true end) and
    (if has("data") then (.data | type == "string") else true end);
  ["application/vnd.oci.image.config.v1+json", "application/vnd.docker.container.image.v1+json"] as $config_types |
  ["application/vnd.oci.image.layer.v1.tar", "application/vnd.oci.image.layer.v1.tar+gzip", "application/vnd.oci.image.layer.v1.tar+zstd",
   "application/vnd.oci.image.layer.nondistributable.v1.tar", "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip", "application/vnd.oci.image.layer.nondistributable.v1.tar+zstd",
   "application/vnd.docker.image.rootfs.diff.tar", "application/vnd.docker.image.rootfs.diff.tar.gzip", "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip"] as $layer_types |
  . as $manifest |
  $config[0] as $image_config |
  if ($manifest | type) != "object" or $manifest.schemaVersion != 2
    or ($manifest.mediaType | type != "string" or IN("application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json") | not)
    or (($manifest | keys - ["schemaVersion", "mediaType", "config", "layers", "annotations", "artifactType"]) | length != 0)
    or (($manifest.config | descriptor($config_types)) | not)
    or ($manifest.layers | type != "array" or any(.[]; descriptor($layer_types) | not))
    or ($image_config | type != "object")
    or ($image_config.rootfs | type != "object" or .type != "layers" or (.diff_ids | type != "array" or any(.[]; type != "string" or test("^sha256:[0-9a-f]{64}$") | not)))
    or (($image_config.rootfs.diff_ids | length) != ($manifest.layers | length))
    or ($image_config.config | type != "object")
    or (($image_config.config.Env // []) | type != "array" or any(.[]; type != "string"))
    or (($image_config.config.Cmd // []) | type != "array" or any(.[]; type != "string"))
  then error("unsupported or malformed schema-2 image manifest/config")
  else $image_config
  end
' < /dev/stdin
