import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { ApplicationService } from "../src/application";
import { createDaemonApp } from "../src/daemon";
import { CommissionStore } from "../src/persistence/sqlite";
import { Ledger } from "../web/app";
import { AnvilApi } from "../web/api";
import { epoch, policy, proposalInput, value } from "./support/fixtures";
import { FakeWorld } from "./support/fake-world";
import { SteeringHarness } from "./support/steering-harness";
import type { SteeringRequest } from "../src/domain";

let cleanup: (() => void) | undefined;
let store: CommissionStore | undefined;
let window: Window | undefined;
let steering: SteeringHarness | undefined;
const originals = new Map<string, PropertyDescriptor | undefined>();
afterEach(async () => {
  cleanup?.();
  store?.close();
  store = undefined;
  steering?.close();
  steering = undefined;
  await window?.happyDOM.close();
  for (const [name, descriptor] of originals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  originals.clear();
});

function installDom() {
  window = new Window({ url: "http://localhost/" });
  for (const [name, object] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: object,
    });
  }
}

test("Ledger components use authenticated daemon data and hold/resume/amend durable state; reject stale amendments", async () => {
  installDom();
  const {
    render,
    fireEvent,
    waitFor,
    cleanup: clean,
  } = await import("@testing-library/react");
  cleanup = clean;
  store = new CommissionStore(":memory:");
  const world = new FakeWorld();
  world.executionKind = "running";
  const application = new ApplicationService(
    store,
    world,
    world,
    world,
    "controller-1",
    policy,
  );
  application.propose(
    proposalInput({ objective: "Deliver reliable unattended work" }),
  );
  value(await application.admit("commission-1", "operator-1", epoch));
  value(await application.reconcile("commission-1", epoch + 1));
  const token = "ui-integration-token-with-32-characters";
  const daemon = createDaemonApp({
    application,
    store,
    policy,
    now: () => epoch + 2,
    config: { bearerToken: token, principalId: "operator-1" },
  });
  const seen: string[] = [];
  const api = new AnvilApi(token, (async (path: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${token}`,
    );
    seen.push(path);
    return daemon.request(path, init);
  }) as typeof fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <Ledger
          api={api}
          area="inbox"
          selectedId="commission-1"
          disconnect={() => client.clear()}
        />
      </QueryClientProvider>
    ),
  });
  const route = createRoute({ getParentRoute: () => root, path: "/" });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const rendered = render(<RouterProvider router={router} />);
  await waitFor(() =>
    expect(rendered.getByText("Controller decision")).toBeDefined(),
  );
  expect(
    rendered.getAllByText("Deliver reliable unattended work").length,
  ).toBeGreaterThan(0);
  expect(rendered.getByText("Execution observation: fresh")).toBeDefined();
  fireEvent.click(rendered.getByRole("tab", { name: "Obligations" }));
  expect(rendered.getByText(/Evidence gap/)).toBeDefined();
  fireEvent.click(rendered.getByRole("tab", { name: "Overview" }));
  fireEvent.change(rendered.getByLabelText("Hold reason"), {
    target: { value: "Operator review boundary" },
  });
  fireEvent.click(rendered.getByRole("button", { name: /^Hold$/ }));
  await waitFor(() =>
    expect(store!.get("commission-1")?.holdReason).toBe(
      "Operator review boundary",
    ),
  );
  await waitFor(() =>
    expect(
      (rendered.getByRole("button", { name: "Resume" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(rendered.getByRole("button", { name: "Resume" }));
  await waitFor(() =>
    expect(store!.get("commission-1")?.lifecycle).toBe("active"),
  );
  fireEvent.click(
    rendered.getByRole("button", { name: "Amend specification" }),
  );
  fireEvent.change(rendered.getByLabelText("Objective"), {
    target: { value: "Deliver reviewed unattended work" },
  });
  fireEvent.click(
    rendered.getByRole("button", { name: "Submit approved amendment" }),
  );
  await waitFor(() =>
    expect(store!.get("commission-1")?.specificationGeneration).toBe(2),
  );
  expect(store.get("commission-1")?.objective).toBe(
    "Deliver reviewed unattended work",
  );
  await expect(
    api.command("commission-1", "amend", {
      expectedGeneration: 1,
      objective: "Overwrite stale criteria",
      integrationTarget: "v2",
      obligations: proposalInput().obligations,
      independentReviewRequired: false,
    }),
  ).rejects.toThrow("409");
  expect(store.get("commission-1")?.specificationGeneration).toBe(2);
  expect(seen).toContain("/api/commissions/commission-1/hold");
  expect(seen).toContain("/api/commissions/commission-1/projection");
  rendered.unmount();
  client.clear();
});

test("Ledger queues real Assignment steering, preserves a retry key after lost HTTP response, renders audit/outcome and stale errors", async () => {
  installDom();
  const {
    render,
    fireEvent,
    waitFor,
    cleanup: clean,
  } = await import("@testing-library/react");
  cleanup = clean;
  const h = new SteeringHarness();
  steering = h;
  await h.initialize();
  h.active = true;
  const token = "steering-ui-test-token-with-32-characters";
  const daemon = createDaemonApp({
    application: h.application,
    store: h.store,
    policy: h.policy,
    now: () => h.now,
    config: { bearerToken: token, principalId: "operator-1" },
  });
  const requests: SteeringRequest[] = [];
  let loseResponse = true;
  const api = new AnvilApi(token, (async (path: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${token}`,
    );
    if (path.endsWith("/steer"))
      requests.push(JSON.parse(init!.body as string) as SteeringRequest);
    const response = await daemon.request(path, init);
    if (path.endsWith("/steer") && loseResponse) {
      loseResponse = false;
      expect(response.status).toBe(202);
      throw new Error("HTTP response lost after journaling");
    }
    return response;
  }) as typeof fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <Ledger
          api={api}
          area="inbox"
          selectedId="commission-1"
          disconnect={() => client.clear()}
        />
      </QueryClientProvider>
    ),
  });
  const route = createRoute({ getParentRoute: () => root, path: "/" });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const rendered = render(<RouterProvider router={router} />);
  await waitFor(() =>
    expect(rendered.getByText("Assignment steering")).toBeDefined(),
  );
  expect(
    (rendered.getByLabelText("Assignment") as HTMLInputElement).value,
  ).toBe("commission-1:assignment-1");
  fireEvent.change(rendered.getByLabelText("Implementation instruction"), {
    target: {
      value:
        "Inspect the actual retry boundary without changing approved criteria.",
    },
  });
  fireEvent.click(rendered.getByRole("button", { name: "Queue steering" }));
  await waitFor(() =>
    expect(rendered.getByRole("alert").textContent).toContain(
      "HTTP response lost",
    ),
  );
  await waitFor(() =>
    expect(
      rendered.getByText("prepared · pending controller resolution"),
    ).toBeDefined(),
  );
  expect(
    h.store.operations("commission-1").filter((o) => o.kind === "steer"),
  ).toHaveLength(1);
  value(await h.reconcile());
  expect(h.prompts).toHaveLength(0);
  fireEvent.click(
    rendered.getByRole("button", { name: "Retry identical steering" }),
  );
  await waitFor(() =>
    expect(rendered.getByRole("status").textContent).toContain(
      "Steering journaled",
    ),
  );
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]!);
  expect(h.store.get("commission-1")!.budget.used.instructions).toBe(1);
  h.active = false;
  value(await h.reconcile());
  await client.invalidateQueries();
  await waitFor(() =>
    expect(
      rendered.getByText("observed · provider outcome recorded"),
    ).toBeDefined(),
  );
  expect(h.prompts).toHaveLength(1);
  expect(
    rendered.getByText(/operator-1 · commission-1:assignment-1/),
  ).toBeDefined();
  fireEvent.click(
    rendered.getByRole("button", { name: "Start a new steering request" }),
  );
  await client.invalidateQueries();
  const c = h.store.get("commission-1")!;
  value(
    await h.application.amendSpecification(
      c.id,
      "operator-1",
      c.specificationGeneration,
      {
        objective: "Updated governed objective",
        integrationTarget: c.integrationTarget,
        obligations: c.obligations,
        independentReviewRequired: c.independentReviewRequired,
      },
      h.now,
    ),
  );
  // The form still has the old projection: it must expose the CAS/generation
  // error, not silently refresh and resubmit the operator's command.
  fireEvent.click(rendered.getByRole("button", { name: "Queue steering" }));
  await waitFor(() =>
    expect(rendered.getByRole("alert").textContent).toContain(
      "stale_generation",
    ),
  );
  expect(
    h.store.operations("commission-1").filter((o) => o.kind === "steer"),
  ).toHaveLength(1);
  expect(h.prompts).toHaveLength(1);
  fireEvent.click(
    rendered.getByRole("button", { name: "Start a new steering request" }),
  );
  value(await h.application.hold(c.id, "review", h.now));
  await client.invalidateQueries();
  await waitFor(() =>
    expect(
      (
        rendered.getByRole("button", {
          name: "Queue steering",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true),
  );
  rendered.unmount();
  client.clear();
});
