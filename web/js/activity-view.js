import {
  basename,
  formatClock,
  formatDuration,
  formatRelativeTime,
  statusText,
} from "./format.js";

export function createActivityView(handlers) {
  const activeList = document.querySelector("#active-list");
  const earlierList = document.querySelector("#earlier-list");
  const activeCount = document.querySelector("#active-count");
  const earlierCount = document.querySelector("#earlier-count");
  const activeEmpty = document.querySelector("#active-empty");
  const earlierEmpty = document.querySelector("#earlier-empty");
  const connection = document.querySelector("#connection-status");
  const connectionLabel = document.querySelector("#connection-label");
  const dialog = document.querySelector("#detail-dialog");
  const dialogTitle = document.querySelector("#dialog-title");
  const dialogEyebrow = document.querySelector("#dialog-eyebrow");
  const dialogBody = document.querySelector("#dialog-body");
  document.querySelector("#dialog-close").addEventListener("click", () => dialog.close());

  function render(view) {
    activeCount.textContent = String(view.active.length);
    earlierCount.textContent = String(view.earlier.length);
    activeEmpty.hidden = view.active.length > 0;
    earlierEmpty.hidden = view.earlier.length > 0;

    replaceChildren(activeList, view.active.map((workspace) => workspaceCard(workspace, view.now, false)));
    replaceChildren(earlierList, view.earlier.map((workspace) => workspaceCard(workspace, view.now, true)));
  }

  function workspaceCard(workspace, now, compact) {
    const card = el("article", "workspace-card");
    const header = el("div", "workspace-header");
    const title = el("div", "workspace-title");
    title.append(
      textEl("h2", "workspace-name", basename(workspace.cwd)),
      textEl("div", "workspace-path", workspace.cwd),
    );

    const meta = el("div", "workspace-meta");
    if (workspace.runningCount > 0) {
      meta.append(textEl("span", "running-badge", `${workspace.runningCount} running`));
    }
    meta.append(textEl("span", "", formatRelativeTime(workspace.lastEventAt, now)));
    header.append(title, meta);
    card.append(header);

    if (!compact) {
      const groups = groupCalls(workspace.recentCalls);
      for (const group of groups) card.append(shellGroup(group));
    }

    const footer = el("div", "workspace-footer");
    const shellsButton = textEl("button", "text-button", compact ? "View history" : "View all shells");
    shellsButton.type = "button";
    shellsButton.addEventListener("click", () => handlers.onWorkspaceOpen?.(workspace.cwd));
    footer.append(shellsButton);
    card.append(footer);

    return card;
  }

  function shellGroup(group) {
    const wrapper = el("div", "shell-group");
    const heading = el("div", "shell-heading");
    const label = group.shellId == null ? "shell pending" : `shell #${group.shellId}`;
    heading.append(textEl("span", "shell-id", label));

    if (group.shellId != null) {
      const history = textEl("button", "shell-history", "History");
      history.type = "button";
      history.addEventListener("click", () => handlers.onShellOpen?.(group.shellId));
      heading.append(history);
    }
    wrapper.append(heading);

    for (const call of group.calls) wrapper.append(callRow(call));
    return wrapper;
  }

  function callRow(call) {
    const row = el("button", "call-row");
    row.type = "button";
    row.disabled = call.status === "running";
    row.append(
      textEl("span", "call-time", formatClock(call.started_at)),
      textEl("span", "call-tool", call.tool),
      textEl("span", `call-status status-${call.status}`, statusText(call)),
    );
    if (call.status !== "running") {
      row.addEventListener("click", () => handlers.onCallOpen?.(call));
    }
    return row;
  }

  function setConnection(state, label) {
    connection.dataset.state = state;
    connectionLabel.textContent = label;
  }

  function showJson(title, eyebrow, value) {
    dialogTitle.textContent = title;
    dialogEyebrow.textContent = eyebrow;
    replaceChildren(dialogBody, [textEl("pre", "detail-pre", JSON.stringify(value, null, 2))]);
    openDialog();
  }

  function showError(title, error) {
    dialogTitle.textContent = title;
    dialogEyebrow.textContent = "Error";
    replaceChildren(dialogBody, [textEl("div", "error-box", error?.message || String(error))]);
    openDialog();
  }

  function showShellHistory(result, onLoadMore) {
    dialogTitle.textContent = `shell #${result.shell.shell_id}`;
    dialogEyebrow.textContent = result.shell.cwd;
    const list = el("div", "history-list");

    for (const call of result.items) {
      const item = el("div", "history-item");
      const button = el("button", "");
      button.type = "button";
      button.append(
        textEl("div", "history-primary", call.tool),
        textEl("div", "history-secondary", `${formatClock(call.started_at)} · ${call.status}`),
      );
      button.addEventListener("click", () => handlers.onCallOpen?.(call));
      item.append(button, textEl("div", "history-secondary", formatDuration(call.duration_ms)));
      list.append(item);
    }

    if (result.items.length === 0) list.append(textEl("p", "empty-state", "No retained calls for this shell."));
    appendLoadMore(list, result.next_cursor, onLoadMore);
    replaceChildren(dialogBody, [list]);
    openDialog();
  }

  function showWorkspaceShells(result, onLoadMore) {
    dialogTitle.textContent = basename(result.cwd);
    dialogEyebrow.textContent = result.cwd;
    const list = el("div", "history-list");

    for (const shell of result.items) {
      const item = el("div", "history-item");
      const button = el("button", "");
      button.type = "button";
      button.append(
        textEl("div", "history-primary", `shell #${shell.shell_id}`),
        textEl("div", "history-secondary", `created ${formatClock(shell.created_at)}`),
      );
      button.addEventListener("click", () => handlers.onShellOpen?.(shell.shell_id));
      item.append(
        button,
        textEl("div", "history-secondary", shell.last_activity_at ? formatRelativeTime(shell.last_activity_at) : "no activity"),
      );
      list.append(item);
    }

    if (result.items.length === 0) list.append(textEl("p", "empty-state", "No shells found for this workspace."));
    appendLoadMore(list, result.next_cursor, onLoadMore);
    replaceChildren(dialogBody, [list]);
    openDialog();
  }

  function openDialog() {
    if (!dialog.open) dialog.showModal();
  }

  return {
    render,
    setConnection,
    showJson,
    showError,
    showShellHistory,
    showWorkspaceShells,
  };
}

function appendLoadMore(container, nextCursor, onLoadMore) {
  if (!nextCursor || !onLoadMore) return;
  const button = textEl("button", "text-button load-more", "Load more");
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Loading…";
    try {
      await onLoadMore(nextCursor);
    } catch {
      button.disabled = false;
      button.textContent = "Load more";
    }
  });
  container.append(button);
}

function groupCalls(calls) {
  const order = [];
  const groups = new Map();

  for (const call of calls) {
    const key = call.shell_id == null ? "pending" : String(call.shell_id);
    if (!groups.has(key)) {
      const group = { shellId: call.shell_id, calls: [] };
      groups.set(key, group);
      order.push(group);
    }
    groups.get(key).calls.push(call);
  }

  return order;
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textEl(tag, className, text) {
  const node = el(tag, className);
  node.textContent = text ?? "";
  return node;
}

function replaceChildren(node, children) {
  node.replaceChildren(...children);
}
