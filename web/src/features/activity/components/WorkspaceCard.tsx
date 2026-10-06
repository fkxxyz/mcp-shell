import { Link } from "@tanstack/react-router";
import type { ToolCallSummaryDto } from "../../../../../src/contracts/activity";
import { basename, formatClock, formatDuration, formatRelativeTime } from "../../../lib/format";
import type { ActivityWorkspaceView } from "../activity-model";
import styles from "../activity.module.css";

export function WorkspaceCard({
  workspace,
  now,
  compact = false,
}: {
  workspace: ActivityWorkspaceView;
  now: number;
  compact?: boolean;
}) {
  const groups = compact ? [] : groupCalls(workspace.recentCalls);

  return (
    <article className={styles.workspaceCard}>
      <header className={styles.workspaceHeader}>
        <div className={styles.workspaceTitle}>
          <h2>{basename(workspace.cwd)}</h2>
          <div className={styles.workspacePath} title={workspace.cwd}>{workspace.cwd}</div>
        </div>
        <div className={styles.workspaceMeta}>
          {workspace.runningCount > 0 && (
            <span className={styles.runningBadge}>{workspace.runningCount} running</span>
          )}
          <span>{formatRelativeTime(workspace.lastEventAt, now)}</span>
        </div>
      </header>

      {groups.map((group) => (
        <section className={styles.shellGroup} key={group.key}>
          <div className={styles.shellHeading}>
            <span>{group.shellId == null ? "shell pending" : `shell #${group.shellId}`}</span>
            {group.shellId != null && (
              <Link to="/shells/$shellId" params={{ shellId: String(group.shellId) }}>
                History
              </Link>
            )}
          </div>
          <div className={styles.callList}>
            {group.calls.map((call) => <CallRow call={call} key={call.id} />)}
          </div>
        </section>
      ))}

      <footer className={styles.workspaceFooter}>
        <Link to="/workspaces" search={{ cwd: workspace.cwd }}>
          {compact ? "View history" : "View all shells"}
        </Link>
      </footer>
    </article>
  );
}

function CallRow({ call }: { call: ToolCallSummaryDto }) {
  const body = (
    <>
      <span className={styles.callTime}>{formatClock(call.started_at)}</span>
      <span className={styles.callTool}>{call.tool}</span>
      <span className={styles.callStatus} data-status={call.status}>{statusText(call)}</span>
    </>
  );

  if (call.status !== "running" && call.payload_available) {
    return (
      <Link
        className={styles.callRow}
        to="/tool-calls/$callId"
        params={{ callId: call.id }}
      >
        {body}
      </Link>
    );
  }

  return <div className={styles.callRow} aria-disabled="true">{body}</div>;
}

type CallGroup = {
  key: string;
  shellId: number | null;
  calls: ToolCallSummaryDto[];
};

function groupCalls(calls: ToolCallSummaryDto[]): CallGroup[] {
  const order: CallGroup[] = [];
  const groups = new Map<string, CallGroup>();

  for (const call of calls) {
    const key = call.shell_id == null ? "pending" : String(call.shell_id);
    let group = groups.get(key);
    if (!group) {
      group = { key, shellId: call.shell_id, calls: [] };
      groups.set(key, group);
      order.push(group);
    }
    group.calls.push(call);
  }
  return order;
}

function statusText(call: ToolCallSummaryDto): string {
  if (call.status === "running") return "running…";
  if (!call.payload_available) return "detail unavailable";
  if (call.status === "error") return call.duration_ms == null ? "error" : `error · ${formatDuration(call.duration_ms)}`;
  return call.duration_ms == null ? "done" : formatDuration(call.duration_ms);
}
