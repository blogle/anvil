{
  pkgs,
  nix2container,
  anvilctl,
}:
let
  opencode-release = pkgs.fetchurl {
    url = "https://github.com/anomalyco/opencode/releases/download/v2.3.2/opencode-linux-x64.tar.gz";
    hash = "sha256-VjtdZjY3ImtuO7S7aAMoG8ObDSzYjbBtZ0tkIKqwCbA=";
  };

  opencode = pkgs.runCommand "opencode" { } ''
    mkdir -p $out/bin
    tar -xf ${opencode-release} -C $out/bin
    chmod +x $out/bin/opencode
  '';
  entrypoint = pkgs.writeShellScriptBin "anvil-entrypoint" ''
    set -euo pipefail
    export PATH=/bin
    export HOME=/workspace/home
    export NIX_REMOTE=daemon
    export GIT_TERMINAL_PROMPT=0
    mkdir -p "$HOME"
    git config --global --add safe.directory '*'
    if [ ! -d /workspace/repo ]; then
      git -c credential.helper='!f() { printf "username=anvil\npassword=%s\n" "$ANVIL_GITHUB_TOKEN"; }; f' \
        clone "''${ANVIL_REPO_URL}" /workspace/repo
    fi
    cd /workspace/repo
    if ! git checkout "$ANVIL_REPO_BRANCH" 2>/dev/null; then
      git checkout -b "$ANVIL_REPO_BRANCH" "origin/$ANVIL_TARGET_REF"
    fi
    exec /bin/opencode serve --hostname 0.0.0.0 --port "''${ANVIL_SERVE_PORT:-4096}"
  '';

  tools = pkgs.buildEnv {
    name = "anvil-sandbox-tools";
    paths = [
      pkgs.bashInteractive
      pkgs.coreutils
      pkgs.findutils
      pkgs.gnugrep
      pkgs.gnused
      pkgs.gawk
      pkgs.gnutar
      pkgs.gzip
      pkgs.xz
      pkgs.unzip
      pkgs.git
      pkgs.curl
      pkgs.jq
      pkgs.ripgrep
      pkgs.less
      pkgs.procps
      pkgs.which
      pkgs.nix
      pkgs.glibc.out
      pkgs.gcc.cc.lib
      pkgs.cacert
      opencode
    ];
    pathsToLink = [ "/bin" "/lib" "/lib64" "/etc" ];
  };

  anvil-side = pkgs.buildEnv {
    name = "anvil-sandbox-control";
    paths = [ anvilctl entrypoint ];
    pathsToLink = [ "/bin" ];
  };
in
nix2container.buildImage {
  name = "anvil-sandbox";
  tag = "latest";
  copyToRoot = [
    tools
    anvil-side
  ];
  layers = [
    (nix2container.buildLayer { deps = [ tools ]; })
  ];
  config = {
    Entrypoint = [ "/bin/anvil-entrypoint" ];
    Env = [
      "PATH=/bin"
      "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      "GIT_SSL_CAINFO=/etc/ssl/certs/ca-bundle.crt"
    ];
  };
}
