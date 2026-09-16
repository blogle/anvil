# API and Runtime Contract

Anvil uses the Agent Sandbox `agents.x-k8s.io/v1beta1` `Sandbox` resource. The
`anvild` process is configured with `ANVIL_SANDBOX_API_VERSION` and
`ANVIL_SANDBOX_NAMESPACE`; it is the sole component allowed to create, observe,
update, patch, or delete those resources in `anvil`.

The base runtime ConfigMap also supplies the internal endpoints:

| Variable | Value | Consumer |
| --- | --- | --- |
| `ANVIL_LISTEN_ADDR` | `0.0.0.0:8080` | anvild |
| `ANVIL_SANDBOX_ROUTER_URL` | Agent Sandbox Router service DNS | anvild |
| `ANVIL_MCP_URL` | `http://anvil-mcp:8081` | anvild/router |
| `ANVIL_ROUTER_URL` | `http://anvil-router:8082` | internal callers |
| `RUST_LOG` | `info` | all services |

The Deployment image names are local development contracts: `anvil/anvild:dev`,
`anvil/mcp:dev`, and `anvil/router:dev`. Every container uses
`imagePullPolicy: Never`; the selected cluster nodes must already contain these
exact images. No secret, token, or kubeconfig belongs in the ConfigMap. The
current repository has no service implementations for these images, so the
manifests do not guess commands, health endpoints, or public HTTP routes.

Ingress accepts `*.anvil.example.invalid` in the base and `*.anvil.test` in the
that boundary is the router image's responsibility.
