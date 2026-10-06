import type { ActivityView } from "../activity-model";
import styles from "../activity.module.css";

export function ActivitySummary({ summary }: { summary: ActivityView["summary"] }) {
  return (
    <dl className={styles.activitySummary} aria-label="Current activity summary">
      <div>
        <dt>active workspaces</dt>
        <dd>{summary.activeWorkspaceCount}</dd>
      </div>
      <div>
        <dt>active shells</dt>
        <dd>{summary.activeShellCount}</dd>
      </div>
      <div>
        <dt>running calls</dt>
        <dd>{summary.runningCallCount}</dd>
      </div>
    </dl>
  );
}
