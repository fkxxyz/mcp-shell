import {
  getToolCall,
  listShellCalls,
  listWorkspaceShells,
  openActivityStream,
} from "./api.js";
import { ActivityState } from "./activity-state.js";
import { createActivityView } from "./activity-view.js";

let latestView;
let state;
let view;

view = createActivityView({
  onCallOpen: async (call) => {
    try {
      const detail = await getToolCall(call.id);
      view.showJson(call.tool, call.cwd || "tool call", detail);
    } catch (error) {
      view.showError("Tool call", error);
    }
  },
  onShellOpen: async (shellId) => {
    try {
      await openShellHistory(shellId);
    } catch (error) {
      view.showError(`shell #${shellId}`, error);
    }
  },
  onWorkspaceOpen: async (cwd) => {
    try {
      await openWorkspaceShells(cwd);
    } catch (error) {
      view.showError("Workspace shells", error);
    }
  },
});

state = new ActivityState((nextView) => {
  latestView = nextView;
  view.render(nextView);
});

view.setConnection("connecting", "Connecting");

openActivityStream({
  onOpen() {
    view.setConnection("live", "Live");
  },
  onError() {
    view.setConnection("error", "Reconnecting");
  },
  onSnapshot(snapshot) {
    state.replaceSnapshot(snapshot);
  },
  onCall(call) {
    state.applyCall(call);
  },
});

setInterval(() => {
  const changed = state.expire();
  if (!changed && latestView) view.render({ ...latestView, now: state.now() });
}, 15_000);

async function openShellHistory(shellId) {
  let result = await listShellCalls(shellId);

  const render = () => {
    view.showShellHistory(result, result.next_cursor ? async (cursor) => {
      const next = await listShellCalls(shellId, cursor);
      result = {
        ...result,
        items: [...result.items, ...next.items],
        next_cursor: next.next_cursor,
      };
      render();
    } : undefined);
  };

  render();
}

async function openWorkspaceShells(cwd) {
  let result = await listWorkspaceShells(cwd);

  const render = () => {
    view.showWorkspaceShells(result, result.next_cursor ? async (cursor) => {
      const next = await listWorkspaceShells(cwd, cursor);
      result = {
        ...result,
        items: [...result.items, ...next.items],
        next_cursor: next.next_cursor,
      };
      render();
    } : undefined);
  };

  render();
}
