import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { AnvilApi } from "./api";
import { Ledger } from "./app";
import { Button } from "./components/button";
import "./style.css";

function Application() {
  const [api, setApi] = useState<AnvilApi | null>(null);
  const [token, setToken] = useState("");
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const params = useParams({ strict: false }) as { id?: string };
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const area = pathname.startsWith("/campaigns")
    ? "campaigns"
    : pathname.startsWith("/operations")
      ? "operations"
      : "inbox";
  if (api === null)
    return (
      <main className="login">
        <p className="brand">Anvil / Ledger</p>
        <h1>Connect to the daemon</h1>
        <p>
          The operator token stays in memory and is sent only to this origin's
          authenticated API.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            client.clear();
            setApi(new AnvilApi(token));
            setToken("");
          }}
        >
          <label className="field">
            API token
            <input
              type="password"
              required
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <Button type="submit">Connect</Button>
        </form>
      </main>
    );
  return (
    <QueryClientProvider client={client}>
      <Ledger
        api={api}
        area={area}
        {...(params.id === undefined ? {} : { selectedId: params.id })}
        disconnect={() => {
          client.clear();
          setApi(null);
        }}
      />
      <Outlet />
    </QueryClientProvider>
  );
}
const root = createRootRoute({ component: Application });
const routes = [
  createRoute({ getParentRoute: () => root, path: "/" }),
  createRoute({ getParentRoute: () => root, path: "/inbox/$id" }),
  createRoute({ getParentRoute: () => root, path: "/campaigns" }),
  createRoute({ getParentRoute: () => root, path: "/operations" }),
];
const router = createRouter({ routeTree: root.addChildren(routes) });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
