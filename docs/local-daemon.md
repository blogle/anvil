# Local daemon

The Bun daemon runs SQLite migrations, serves the authenticated HTTP/MCP
application surface, and scans durable active Commissions on a bounded interval.
It defaults to the explicit unavailable provider. An opt-in configured mode
composes Agent Sandbox, OpenCode V2, GitHub App/REST, and Mergify clients; exact
settings and provider limits are documented in
[`provider-contracts/runtime-configuration.md`](provider-contracts/runtime-configuration.md).
The configured mode is fixture-tested but has not been deployed, validated for
multi-controller operation, or accepted as a live provider integration.

## Run

From the repository root, inside `nix develop`:

```sh
export ANVIL_API_TOKEN='<locally generated bearer token of at least 32 characters>'
export ANVIL_DATABASE='./anvil-local.sqlite'
export PORT=8080
bun run start
```

The database file is local application state and should not be committed. The
default controller is single-process/local only; it is not a Kubernetes Lease
implementation or HA/fencing contract. The operator identity defaults to
`local-operator`, and admission/amendment authorization is scoped to that
configured identity and the bearer credential. The current unavailable provider
means active work remains waiting/unavailable until an adapter is configured.

Unauthenticated `GET /healthz` and `GET /readyz` expose process and migration
readiness. Other HTTP and MCP requests require `Authorization: Bearer $ANVIL_API_TOKEN`.

## HTTP surface

- `GET /api/commissions` and `GET /api/commissions/:id`
- `GET /api/commissions/:id/operations`
- `POST /api/commissions` (typed proposal)
- `POST /api/commissions/:id/admit`
- `POST /api/commissions/:id/hold` with `{ "reason": "..." }`
- `POST /api/commissions/:id/resume`
- `POST /api/commissions/:id/amend` with expected generation and typed criteria
- `POST /api/commissions/:id/reconcile`
- Streamable MCP at `/mcp`: `list_commissions`, `get_commission`,
  `admit_commission`, `hold_commission`, and `resume_commission` use the same
  `ApplicationService` commands and SQLite projections as HTTP.

This is a local application checkpoint, not a complete FS-11 surface: Campaign,
Assignment, Findings, steer, and full history projections/tools remain gaps. MCP
session state is process-local and clients must reinitialize after daemon restart.
