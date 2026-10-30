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

let cleanup: (() => void) | undefined;
let store: CommissionStore | undefined;
let window: Window | undefined;
const originals = new Map<string, PropertyDescriptor | undefined>();
afterEach(async () => {
  cleanup?.();
  store?.close();
  await window?.happyDOM.close();
  for (const [name, descriptor] of originals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  originals.clear();
});

test("Ledger components use authenticated daemon data and hold/resume/amend durable state; reject stale amendments", async () => {
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
