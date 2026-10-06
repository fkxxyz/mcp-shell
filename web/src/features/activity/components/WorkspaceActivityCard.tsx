import { Link } from "@tanstack/react-router";
import { basename, formatRelativeTime } from "../../../lib/format";
import type { ActivityWorkspaceView } from "../activity-model";
import { ActivityCallRow } from "./ActivityCallRow";
import styles from "../activity.module.css";

export function WorkspaceActivityCard({
  workspace,
  now,
}: {
  workspace: ActivityWorkspaceView;
  now: number;
}) {
  return (
    <article className={styles.workspaceCard}>
      <header className={styles.workspaceHeader}>
        <div className={styles.workspaceIdentity}>
          <Link
            className={styles.workspaceName}
            to="/workspaces"
            search={{ cwd: workspace.cwd }}
            title={workspace.cwd}
          >
            {basename(workspace.cwd)}
          </Link>
          <div className={styles.workspacePath} title={workspace.cwd}>{workspace.cwd}</div>
        </div>
        <div className={styles.workspaceMeta}>
          {workspace.activeShellCount > 0 && (
            <span>{workspace.activeShellCount} active {workspace.activeShellCount === 1 ? "shell" : "shells"}</span>
          )}
          {workspace.runningCount > 0 && <span>{workspace.runningCount} running</span>}
          <span>{formatRelativeTime(workspace.lastEventAt, now)}</span>
        </div>
      </header>

      <div className={styles.callList}>
        {workspace.visibleCalls.map((call) => (
          <ActivityCallRow call={call} now={now} key={call.id} />
        ))}
        {workspace.visibleCalls.length === 0 && (
          <p className={styles.noCalls}>No recent calls.</p>
        )}
      </div>
    </article>
  );
}
