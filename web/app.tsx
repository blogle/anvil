import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Commission } from "../src/domain";
import { AnvilApi, type CommissionView } from "./api";
import { Button } from "./components/button";

export function Ledger({
  api,
  area,
  selectedId,
  disconnect,
}: {
  api: AnvilApi;
  area: "inbox" | "campaigns" | "operations";
  selectedId?: string;
  disconnect: () => void;
}) {
  const [search, setSearch] = useState("");
  const [repository, setRepository] = useState("");
  const [status, setStatus] = useState("");
  const [focused, setFocused] = useState(false);
  const list = useQuery({
    queryKey: ["commissions"],
    queryFn: () => api.commissions(),
    refetchInterval: 5000,
  });
  const commissions = list.data ?? [];
  const filtered = commissions.filter(
    (c) =>
      `${c.id} ${c.objective} ${c.repository} ${c.registeredPullRequestId ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (!repository || c.repository === repository) &&
      (!status || c.lifecycle === status) &&
      (!focused || c.lifecycle === "held"),
  );
  const campaigns = [...new Set(commissions.map((c) => c.campaignId))];
  return (
    <div className="ledger">
      <header>
        <Link to="/" className="brand">
          Anvil
        </Link>
        <span>/ {area} / durable operational state</span>
        <Button onClick={disconnect}>Disconnect</Button>
      </header>
      <div className="frame">
        <nav aria-label="Primary application areas">
          <p className="eyebrow">Workspace</p>
          <Link to="/">Inbox</Link>
          <Link to="/campaigns">Campaigns</Link>
          <Link to="/operations">Operations</Link>
          <p className="muted">
            Authenticated daemon
            <br />
            Polling every 5 seconds
          </p>
        </nav>
        <main>
          <div
            className={
              selectedId === undefined
                ? "workspace"
                : "workspace with-inspector"
            }
          >
            <section className="primary">
              <p className="eyebrow">Commission control</p>
              <h1>
                {area === "inbox"
                  ? "Inbox"
                  : area === "campaigns"
                    ? "Campaigns"
                    : "Operations"}
              </h1>
              {list.isError && <p role="alert">{list.error.message}</p>}
              {list.isPending && (
                <p role="status">Loading authenticated state…</p>
              )}
              <p className="muted">
                Last fetched{" "}
                {list.dataUpdatedAt
                  ? new Date(list.dataUpdatedAt).toLocaleTimeString()
                  : "unavailable"}
                . Provider observation times are shown separately.
              </p>
              <label className="field">
                Search Commissions
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Objective, repository, PR or ID"
                />
              </label>
              <div className="toolbar">
                <label>
                  Repository
                  <select
                    value={repository}
                    onChange={(e) => setRepository(e.target.value)}
                  >
                    <option value="">All repositories</option>
                    {[...new Set(commissions.map((c) => c.repository))].map(
                      (r) => (
                        <option key={r}>{r}</option>
                      ),
                    )}
                  </select>
                </label>
                <label>
                  Status
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    <option value="">All statuses</option>
                    {["proposed", "active", "held", "concluded"].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
                {area === "inbox" && (
                  <Button
                    aria-pressed={focused}
                    onClick={() => setFocused(!focused)}
                  >
                    {focused ? "Needs attention · held" : "Everything"}
                  </Button>
                )}
              </div>
              {area === "campaigns"
                ? campaigns.map((id) => (
                    <section className="panel" key={id}>
                      <h2>{id}</h2>
                      <p className="muted">
                        Registered Commission grouping. Campaign specification
                        and dependency graph are unavailable.
                      </p>
                      {filtered
                        .filter((c) => c.campaignId === id)
                        .map((c) => (
                          <CommissionRow key={c.id} commission={c} />
                        ))}
                    </section>
                  ))
                : filtered.map((c) => (
                    <CommissionRow key={c.id} commission={c} />
                  ))}
              {!list.isPending && !list.isError && filtered.length === 0 && (
                <p className="empty">No Commissions match these filters.</p>
              )}
              {area === "operations" && (
                <p className="notice">
                  Select a Commission to inspect its authoritative Operation
                  journal. Fleet health, provider cost estimates and performance
                  aggregates are unavailable.
                </p>
              )}
            </section>
            {selectedId !== undefined && (
              <Inspector key={selectedId} id={selectedId} api={api} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function CommissionRow({ commission: c }: { commission: Commission }) {
  return (
    <Link to="/inbox/$id" params={{ id: c.id }} className="commission-row">
      <div>
        <strong>{c.objective}</strong>
        <small>
          {c.id} · {c.repository}
        </small>
        <small>
          Target {c.integrationTarget} · PR{" "}
          {c.registeredPullRequestId ?? "not registered"}
        </small>
      </div>
      <div>
        <span className={`state ${c.lifecycle}`}>
          {c.lifecycle === "concluded" ? "Integrated" : c.lifecycle}
        </span>
        <small>
          {c.obligations.length} obligations · generation{" "}
          {c.specificationGeneration}
        </small>
        <small>
          {c.lifecycle === "concluded"
            ? "Deployment unknown"
            : (c.holdReason ?? "Inspect current decision")}
        </small>
      </div>
    </Link>
  );
}

export function Inspector({ id, api }: { id: string; api: AnvilApi }) {
  const [tab, setTab] = useState("Overview");
  const query = useQuery({
    queryKey: ["projection", id],
    queryFn: () => api.projection(id),
    refetchInterval: 5000,
  });
  const history = useQuery({
    queryKey: ["history", id],
    queryFn: () => api.history(id),
    refetchInterval: 5000,
  });
  const view = query.data;
  return (
    <aside aria-label="Commission inspector">
      <Link to="/" className="back">
        ← Back to Inbox
      </Link>
      {query.isPending && <p role="status">Loading Commission…</p>}
      {query.isError && <p role="alert">{query.error.message}</p>}
      {view !== undefined && (
        <>
          <div className="inspector-head">
            <p className="eyebrow">
              {id} / {view.commission.campaignId}
            </p>
            <h2>{view.commission.objective}</h2>
            <p>{view.commission.repository}</p>
            <p className="muted">
              Candidate {view.commission.candidateRevision ?? "unavailable"}
              <br />
              Specification {view.commission.specificationGeneration} · state
              version {view.commission.version}
            </p>
            <span className="state">
              Execution observation: {view.freshness}
            </span>
          </div>
          <div role="tablist" aria-label="Commission detail" className="tabs">
            {[
              "Overview",
              "Obligations",
              "Operations",
              "Findings",
              "Activity",
              "Attempts",
            ].map((name) => (
              <Button
                key={name}
                role="tab"
                aria-selected={tab === name}
                onClick={() => setTab(name)}
              >
                {name}
              </Button>
            ))}
          </div>
          <div className="inspector-body" role="tabpanel">
            {tab === "Overview" && (
              <>
                <section className="panel decision">
                  <h3>Controller decision</h3>
                  {!view.decisionApplicable && (
                    <p className="notice">
                      Decision unavailable or superseded by a command. Await
                      reconciliation.
                    </p>
                  )}
                  <Json
                    value={
                      view.reconciliation?.result ??
                      "No reconciliation recorded"
                    }
                  />
                  <p className="muted">
                    Recorded{" "}
                    {view.reconciliation
                      ? new Date(view.reconciliation.recordedAt).toISOString()
                      : "never"}
                    . Wake conditions are controller intent; the scheduler polls
                    at its configured interval.
                  </p>
                </section>
                <section className="panel">
                  <h3>Provider facts</h3>
                  <Json
                    value={
                      view.reconciliation?.observation?.value ?? "Unavailable"
                    }
                  />
                </section>
                <section className="panel">
                  <h3>Remaining budget</h3>
                  <Json value={view.commission.budget} />
                </section>
                <Interventions api={api} view={view} />
              </>
            )}
            {tab === "Obligations" &&
              view.commission.obligations.map((o) => (
                <section key={o.id} className="panel">
                  <h3>
                    {o.id} · {o.description}
                  </h3>
                  <p>
                    {view.acceptanceGaps.includes(o.id)
                      ? "Evidence gap"
                      : "Applicable evidence present"}{" "}
                    · Independent review{" "}
                    {view.commission.independentReviewRequired ||
                    o.independentReviewRequired
                      ? "required"
                      : "not required"}
                  </p>
                  {view.evidence
                    .filter((e) => e.obligationId === o.id)
                    .map((e) => (
                      <div key={e.id} className="evidence">
                        <strong>
                          {e.source.kind} · {e.disposition}
                        </strong>
                        <p>{e.claim}</p>
                        <small>
                          {e.source.identity} · SHA {e.candidateRevision} ·
                          generation {e.specificationGeneration}
                          <br />
                          {new Date(e.observedAt).toISOString()} →{" "}
                          {new Date(e.expiresAt).toISOString()}
                        </small>
                      </div>
                    ))}
                </section>
              ))}
            {tab === "Operations" && (
              <>
                <h3>Pending effects</h3>
                <Json value={view.pendingOperations} />
                <h3>Durable Operation journal</h3>
                {view.attempts
                  .flatMap((a) => a.operations)
                  .map((o) => (
                    <section className="panel" key={o.id}>
                      <h3>
                        {o.kind} · {o.outcome.kind}
                      </h3>
                      <Json value={o} />
                    </section>
                  ))}
              </>
            )}
            {tab === "Findings" && (
              <>
                <p>
                  Controller Finding references attached to Operations; worker
                  assessments are not independently accepted Findings.
                </p>
                {view.attempts
                  .flatMap((a) => a.operations)
                  .filter((o) => o.findingIds.length > 0)
                  .map((o) => (
                    <section className="panel" key={o.id}>
                      <h3>{o.findingIds.join(", ")}</h3>
                      <p>{o.directive}</p>
                      <small>
                        Source Operation {o.id} · Candidate{" "}
                        {o.candidateRevision ?? "unavailable"}
                      </small>
                    </section>
                  ))}
              </>
            )}
            {tab === "Activity" && (
              <>
                {history.isError && <p role="alert">{history.error.message}</p>}
                {history.data?.map((h) => (
                  <section className="panel" key={h.sequence}>
                    <small>
                      #{h.sequence} · version {h.commissionVersion} ·{" "}
                      {new Date(h.recordedAt).toISOString()}
                    </small>
                    <Json value={h.result} />
                  </section>
                ))}
                <p className="muted">
                  Latest 100 decisions/errors. Provider transcripts are not
                  replayed.
                </p>
              </>
            )}
            {tab === "Attempts" && (
              <Json
                value={view.attempts.map(({ operations, ...a }) => ({
                  ...a,
                  operationIds: operations.map((o) => o.id),
                }))}
              />
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function Interventions({ api, view }: { api: AnvilApi; view: CommissionView }) {
  const client = useQueryClient();
  const c = view.commission;
  const [reason, setReason] = useState("");
  const [amending, setAmending] = useState(false);
  const [objective, setObjective] = useState(c.objective);
  const [criteria, setCriteria] = useState(
    JSON.stringify(c.obligations, null, 2),
  );
  const mutation = useMutation({
    mutationFn: ({
      command,
      body,
    }: {
      command: "hold" | "resume" | "amend";
      body: unknown;
    }) => api.command(c.id, command, body),
    onSuccess: async () => {
      setAmending(false);
      await client.invalidateQueries();
    },
  });
  const amend = (e: FormEvent) => {
    e.preventDefault();
    let obligations: unknown;
    try {
      obligations = JSON.parse(criteria);
    } catch {
      return;
    }
    mutation.mutate({
      command: "amend",
      body: {
        expectedGeneration: c.specificationGeneration,
        objective,
        obligations,
        integrationTarget: c.integrationTarget,
        independentReviewRequired: c.independentReviewRequired,
      },
    });
  };
  return (
    <section className="panel">
      <h3>Authorized interventions</h3>
      {mutation.isError && <p role="alert">{mutation.error.message}</p>}
      {mutation.isSuccess && (
        <p role="status">Command accepted. Refreshing authoritative state.</p>
      )}
      <label className="field">
        Hold reason
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="toolbar">
        <Button
          disabled={
            !reason.trim() || mutation.isPending || c.lifecycle === "concluded"
          }
          onClick={() => mutation.mutate({ command: "hold", body: { reason } })}
        >
          Hold
        </Button>
        <Button
          disabled={c.lifecycle !== "held" || mutation.isPending}
          onClick={() => mutation.mutate({ command: "resume", body: {} })}
        >
          Resume
        </Button>
        <Button
          disabled={c.lifecycle === "concluded"}
          onClick={() => setAmending(!amending)}
        >
          Amend specification
        </Button>
      </div>
      {amending && (
        <form onSubmit={amend}>
          <p className="notice">
            Governed amendment against generation {c.specificationGeneration}.
            Changed criteria invalidate affected evidence.
          </p>
          <label className="field">
            Objective
            <textarea
              required
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
            />
          </label>
          <label className="field">
            Obligations (typed JSON)
            <textarea
              required
              rows={10}
              value={criteria}
              onChange={(e) => {
                e.target.setCustomValidity("");
                try {
                  JSON.parse(e.target.value);
                } catch {
                  e.target.setCustomValidity("Enter valid JSON");
                }
                setCriteria(e.target.value);
              }}
            />
          </label>
          <Button type="submit" disabled={mutation.isPending}>
            Submit approved amendment
          </Button>
        </form>
      )}
      <p className="muted">
        Interactive Assignment steering and external preview/session URLs are
        unavailable in this runtime contract.
      </p>
    </section>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre>
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}
