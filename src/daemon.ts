import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { ApplicationService, ApplicationError } from "./application";
import type { CommissionProposalInput, Policy } from "./domain";
import type { CommissionStore } from "./persistence/sqlite";

export type DaemonConfig = Readonly<{
  bearerToken: string;
  principalId: string;
}>;

export type DaemonDependencies = Readonly<{
  application: ApplicationService;
  store: CommissionStore;
  config: DaemonConfig;
  policy: Policy;
  now?: () => number;
}>;

const obligationSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    independentReviewRequired: z.boolean(),
  })
  .strict();

const proposalSchema = z
  .object({
    id: z.string().min(1),
    campaignId: z.string().min(1),
    objective: z.string().min(1),
    repository: z.string().url(),
    integrationTarget: z.string().min(1),
    obligations: z.array(obligationSchema).min(1),
    independentReviewRequired: z.boolean(),
    budget: z
      .object({
        maxAttempts: z.number().int().nonnegative(),
        maxInstructions: z.number().int().nonnegative(),
        maxRepairs: z.number().int().nonnegative(),
        maxCostMicros: z.number().int().nonnegative(),
        deadlineAt: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<CommissionProposalInput>;

const amendmentSchema = z
  .object({
    expectedGeneration: z.number().int().positive(),
    objective: z.string().min(1),
    integrationTarget: z.string().min(1),
    obligations: z.array(obligationSchema).min(1),
    independentReviewRequired: z.boolean(),
  })
  .strict();

type McpSession = Readonly<{
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
}>;

export function createDaemonApp(dependencies: DaemonDependencies): Hono {
  const { application, store, config } = dependencies;
  const now = dependencies.now ?? Date.now;
  const sessions = new Map<string, McpSession>();
  const app = new Hono();
  const authenticate = async (
    request: Request,
  ): Promise<Response | undefined> => {
    const authorization = request.headers.get("authorization");
    const prefix = "Bearer ";
    if (authorization === null || !authorization.startsWith(prefix))
      return Response.json({ error: "unauthorized" }, { status: 401 });
    const supplied = authorization.slice(prefix.length);
    const expectedBytes = Buffer.from(config.bearerToken);
    const suppliedBytes = Buffer.from(supplied);
    const valid =
      suppliedBytes.length === expectedBytes.length &&
      timingSafeEqual(suppliedBytes, expectedBytes);
    return valid
      ? undefined
      : Response.json({ error: "unauthorized" }, { status: 401 });
  };

  app.get("/healthz", (context) => context.json({ status: "ok" }));
  app.get("/readyz", (context) => {
    try {
      store.migrationVersion();
      return context.json({ status: "ready" });
    } catch {
      return context.json({ status: "not_ready" }, 503);
    }
  });

  app.use("/api/*", async (context, next) => {
    const rejected = await authenticate(context.req.raw);
    if (rejected !== undefined) return rejected;
    await next();
  });
  app.use("/mcp", async (context, next) => {
    const rejected = await authenticate(context.req.raw);
    if (rejected !== undefined) return rejected;
    await next();
  });

  app.get("/api/commissions", (context) =>
    context.json({ commissions: store.list() }),
  );
  app.post("/api/commissions", async (context) => {
    const parsed = proposalSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    const result = application.propose(parsed.data);
    return result.ok
      ? context.json({ commission: store.get(parsed.data.id) }, 201)
      : errorResponse(result.error);
  });
  app.get("/api/commissions/:id", (context) => {
    const commission = store.get(context.req.param("id"));
    return commission === null
      ? context.json({ error: "not_found" }, 404)
      : context.json({ commission });
  });
  app.get("/api/commissions/:id/operations", (context) => {
    const id = context.req.param("id");
    if (store.get(id) === null)
      return context.json({ error: "not_found" }, 404);
    return context.json({ operations: store.operations(id) });
  });
  app.post("/api/commissions/:id/admit", async (context) => {
    const result = await application.admit(
      context.req.param("id"),
      config.principalId,
      now(),
    );
    return result.ok
      ? context.json({ commission: result.value })
      : errorResponse(result.error);
  });
  app.post("/api/commissions/:id/hold", async (context) => {
    const body = z
      .object({ reason: z.string().min(1) })
      .strict()
      .safeParse(await readJson(context.req.raw));
    if (!body.success) return context.json({ error: "invalid_request" }, 400);
    const result = await application.hold(
      context.req.param("id"),
      body.data.reason,
      now(),
    );
    return result.ok
      ? context.json({ commission: result.value })
      : errorResponse(result.error);
  });
  app.post("/api/commissions/:id/resume", async (context) => {
    const result = await application.resume(context.req.param("id"), now());
    return result.ok
      ? context.json({ commission: result.value })
      : errorResponse(result.error);
  });
  app.post("/api/commissions/:id/amend", async (context) => {
    const body = amendmentSchema.safeParse(await readJson(context.req.raw));
    if (!body.success) return context.json({ error: "invalid_request" }, 400);
    const { expectedGeneration, ...amendment } = body.data;
    const result = await application.amendSpecification(
      context.req.param("id"),
      config.principalId,
      expectedGeneration,
      amendment,
      now(),
    );
    return result.ok
      ? context.json({ commission: result.value })
      : errorResponse(result.error);
  });
  app.post("/api/commissions/:id/reconcile", async (context) => {
    const result = await application.reconcile(context.req.param("id"), now());
    return result.ok ? context.json(result.value) : errorResponse(result.error);
  });
  app.all("/mcp", async (context) => {
    const raw = context.req.raw;
    const method = await raw
      .clone()
      .json()
      .then(
        (body: unknown) =>
          z.object({ method: z.string() }).passthrough().parse(body).method,
      )
      .catch(() => "");
    const sessionId = raw.headers.get("mcp-session-id");
    let session = sessionId === null ? undefined : sessions.get(sessionId);
    if (session === undefined && method === "initialize") {
      session = await createMcpSession(
        dependencies,
        (id) => sessions.set(id, session!),
        (id) => sessions.delete(id),
        now,
      );
    }
    if (session === undefined)
      return context.json({ error: "invalid_or_missing_mcp_session" }, 404);
    return session.transport.handleRequest(raw);
  });

  app.onError((error, context) => {
    console.error(
      JSON.stringify({ event: "http_request_failed", message: error.message }),
    );
    return context.json({ error: "internal_error" }, 500);
  });
  return app;
}

async function createMcpSession(
  dependencies: DaemonDependencies,
  onInitialized: (sessionId: string) => void,
  onClosed: (sessionId: string) => void,
  now: () => number,
): Promise<McpSession> {
  const server = new McpServer({ name: "anvil", version: "0.1.0" });
  const { application, store, config } = dependencies;
  const text = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  });
  server.registerTool(
    "list_commissions",
    { description: "List durable Commission state." },
    async () => text({ commissions: store.list() }),
  );
  server.registerTool(
    "propose_commission",
    {
      description: "Create a typed durable Commission proposal.",
      inputSchema: proposalSchema,
    },
    async (proposal) => text(application.propose(proposal)),
  );
  server.registerTool(
    "get_commission",
    {
      description: "Read one Commission and its current durable state.",
      inputSchema: { commissionId: z.string().min(1) },
    },
    async ({ commissionId }) => {
      const commission = store.get(commissionId);
      return text(
        commission === null
          ? { error: "not_found" }
          : { commission, operations: store.operations(commissionId) },
      );
    },
  );
  server.registerTool(
    "admit_commission",
    {
      description:
        "Admit a proposed Commission through the authorized application command.",
      inputSchema: { commissionId: z.string().min(1) },
    },
    async ({ commissionId }) => {
      const result = await application.admit(
        commissionId,
        config.principalId,
        now(),
      );
      return text(result);
    },
  );
  server.registerTool(
    "hold_commission",
    {
      description: "Hold autonomous execution for an authorized Commission.",
      inputSchema: {
        commissionId: z.string().min(1),
        reason: z.string().min(1),
      },
    },
    async ({ commissionId, reason }) =>
      text(await application.hold(commissionId, reason, now())),
  );
  server.registerTool(
    "resume_commission",
    {
      description: "Resume an operator-held Commission.",
      inputSchema: { commissionId: z.string().min(1) },
    },
    async ({ commissionId }) =>
      text(await application.resume(commissionId, now())),
  );
  server.registerTool(
    "amend_commission",
    {
      description:
        "Amend an approved specification with an expected generation.",
      inputSchema: {
        commissionId: z.string().min(1),
        ...amendmentSchema.shape,
      },
    },
    async ({ commissionId, expectedGeneration, ...amendment }) =>
      text(
        await application.amendSpecification(
          commissionId,
          config.principalId,
          expectedGeneration,
          amendment,
          now(),
        ),
      ),
  );
  server.registerTool(
    "reconcile_commission",
    {
      description: "Run one authorized reconciliation cycle for a Commission.",
      inputSchema: { commissionId: z.string().min(1) },
    },
    async ({ commissionId }) =>
      text(await application.reconcile(commissionId, now())),
  );

  let transport: WebStandardStreamableHTTPServerTransport;
  transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    maxRequestBodySize: 1_048_576,
    onsessioninitialized: onInitialized,
    onsessionclosed: onClosed,
  });
  await server.connect(transport);
  return { server, transport };
}

async function readJson(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}

function errorResponse(error: ApplicationError): Response {
  const status =
    error.kind === "not_found"
      ? 404
      : error.kind === "unauthorized"
        ? 403
        : error.kind === "provider" || error.kind === "ownership_unavailable"
          ? 503
          : 409;
  return Response.json({ error }, { status });
}

export type ReconciliationLoop = Readonly<{
  stop: () => Promise<void>;
}>;

export function startReconciliationLoop(
  application: ApplicationService,
  store: CommissionStore,
  options: Readonly<{
    intervalMs: number;
    now?: () => number;
    onResult?: (commissionId: string, error: unknown) => void;
  }>,
): ReconciliationLoop {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let launch: () => void;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(launch, options.intervalMs);
  };
  const run = async (): Promise<void> => {
    const currentTime = (options.now ?? Date.now)();
    for (const commission of store.list()) {
      if (stopped) break;
      if (commission.lifecycle !== "active" && commission.lifecycle !== "held")
        continue;
      try {
        const result = await application.reconcile(commission.id, currentTime);
        if (!result.ok) options.onResult?.(commission.id, result.error);
      } catch (error) {
        options.onResult?.(commission.id, error);
      }
    }
    schedule();
  };
  launch = () => {
    inFlight = run();
  };
  launch();
  return {
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await inFlight;
    },
  };
}
