---
summary: "Defines process shutdown ownership, work-admission boundaries, graceful tool draining, and final resource teardown."
viewpoint: dynamic
stakeholders:
  - architect
  - developer
  - operator
concerns:
  - correctness
  - operability
  - maintainability
activities:
  - orient
  - change
  - diagnose
  - operate
  - assess
facets:
  domain:
    - whole-system
    - access-and-transport
    - mcp-runtime
    - host-tools
    - observability
---

# Process Lifecycle

## Authority

`src/main.ts` is the sole owner of process signals. Subsystems expose lifecycle operations but do not independently handle `SIGINT` or `SIGTERM`.

Shutdown is governed by one ordering rule:

> Once shutdown starts, new work cannot enter; existing work reaches a terminal state before any shared resource it may access is destroyed.

## Shutdown Sequence

1. The composition root receives `SIGINT` or `SIGTERM` and starts HTTP-server close together with application close.
2. Application close synchronously closes HTTP-request admission, tool-invocation admission, and new MCP-session initialization. Activity and standalone MCP SSE streams are closed so idle long-lived streams do not delay shutdown.
3. Tool invocations already admitted receive up to **three seconds** to finish normally. A tool that finishes in this window may return its normal result to the client.
4. If invocations remain after the grace window, external-process-backed cancellable invocations are first marked as interrupted by server shutdown. Their eventual tool result is therefore an interruption even if a child handles `SIGTERM` and exits with status zero. `ProcessSupervisor` then sends `SIGTERM` to tracked tool process groups, waits one additional second, and sends `SIGKILL` to any surviving group; the LSP manager is closed explicitly by the application lifecycle rather than by process-signal handlers.
5. Invocation draining remains authoritative for in-process work. Structured file-mutation critical sections are not forcibly marked cancellable merely because the three-second external-process grace expired; shared stores remain available until admitted invocations finish or the service manager applies its final hard stop.
6. After invocations drain, admitted HTTP requests are allowed to finish so completed tool results can leave the process. MCP transports are then closed.
7. Remote authorization state is persisted last, after request-side mutation has stopped, and durable Shell storage is closed after all users have drained.
8. After admitted responses drain, the composition root closes idle keep-alive connections and waits for the Node HTTP server to close. Shutdown is complete only when both application cleanup and listener teardown have converged.

The three-second window is a completion opportunity, not a delay applied to every restart. When no tool invocation is active, shutdown proceeds immediately.

## systemd Contract

The repository owns the systemd lifecycle contract through `deploy/systemd/mcp-shell.service.in`. `npm run service:install` renders only the machine-specific Node executable and compiled entrypoint into the user's service unit, then reloads the user manager; it does not build, enable, start, or restart the service. An existing unit without the mcp-shell managed marker is not replaced unless the operator explicitly supplies `--replace-existing`.

The lifecycle-critical service settings are:

```ini
Type=simple
KillSignal=SIGTERM
KillMode=mixed
SendSIGKILL=yes
TimeoutStopSec=15s
```

`KillMode=mixed` is required for the application-owned three-second tool grace: the initial stop signal reaches only the main process, while systemd still applies its final `SIGKILL` to the whole service cgroup if the main process does not converge. `KillMode=control-group` would send the initial `SIGTERM` to tool descendants immediately and therefore bypass the application grace period.

`TimeoutStopSec` is the outer failure bound, not the normal shutdown mechanism. It must remain comfortably larger than the application grace and child-process escalation windows.

`Type=simple` deliberately means that successful `systemctl start` or `restart` reports process creation, not application readiness. The current architecture has no systemd-specific readiness protocol; add one only when an operator contract requires restart completion to prove listener readiness.

`npm run service:check` verifies the installed managed unit, configured executable paths, pending daemon reload state, and effective lifecycle properties reported by systemd. Repository tests verify the template and installer/checker logic without operating the developer's real user service.

## Restart Semantics

Restart invalidates process-local MCP sessions. Durable Shell IDs and persisted OAuth state retain their existing durability semantics. An external-process-backed tool still running after the graceful window is reported as interrupted by server shutdown rather than as a normal success; clients must reconnect and reinitialize the MCP session after restart.
