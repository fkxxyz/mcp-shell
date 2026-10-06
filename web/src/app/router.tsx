import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { AppShell } from "./AppShell";
import { ActivityPage } from "../routes/ActivityPage";
import { ShellPage } from "../routes/ShellPage";
import { ToolCallPage } from "../routes/ToolCallPage";
import { WorkspacePage } from "../routes/WorkspacePage";

const rootRoute = createRootRoute({
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/activity" });
  },
});

const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activity",
  component: ActivityPage,
});

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces",
  validateSearch: (search: Record<string, unknown>) => ({
    cwd: typeof search.cwd === "string" ? search.cwd : "",
  }),
  component: () => {
    const { cwd } = workspaceRoute.useSearch();
    return <WorkspacePage cwd={cwd} />;
  },
});

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/shells/$shellId",
  component: () => {
    const { shellId } = shellRoute.useParams();
    return <ShellPage shellId={Number(shellId)} />;
  },
});

const toolCallRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tool-calls/$callId",
  component: () => {
    const { callId } = toolCallRoute.useParams();
    return <ToolCallPage callId={callId} />;
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  activityRoute,
  workspaceRoute,
  shellRoute,
  toolCallRoute,
]);

export const router = createRouter({
  routeTree,
  basepath: "/console",
  defaultPreload: "intent",
  defaultNotFoundComponent: () => (
    <section>
      <h1>Not found</h1>
      <p>This console route does not exist.</p>
    </section>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
