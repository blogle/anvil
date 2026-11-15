# Web development

For live development against the `dotfiles` cluster, run from the repository
root (with dependencies installed and a working Kubernetes context):

```sh
nix develop -c npm --prefix web run dev:live
```

The helper starts Next.js on `127.0.0.1:3000` and forwards
`dotfiles/service/anvild` from local `127.0.0.1:18080` to service port 8080
(equivalent to
`kubectl -n dotfiles port-forward --address 127.0.0.1 service/anvild 18080:8080`).
Both listeners are loopback-only; the web app and API forward are not exposed on
the network. Stop with Ctrl-C to stop both processes. `DEV_LIVE_PORT` and
`ANVIL_FORWARD_PORT` can change the local ports.
