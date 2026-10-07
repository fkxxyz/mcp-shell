import { useActivityView } from "../features/activity/ActivityProvider";
import { ActivitySummary } from "../features/activity/components/ActivitySummary";
import { WorkspaceActivityCard } from "../features/activity/components/WorkspaceActivityCard";
import styles from "../features/activity/activity.module.css";

export function ActivityPage() {
  const view = useActivityView();

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <h1>Activity</h1>
          <p>Live tool activity grouped by workspace root.</p>
        </div>
        <ActivitySummary summary={view.summary} />
      </header>

      <section className={styles.activitySection} aria-labelledby="active-heading">
        <div className={styles.sectionHeading}>
          <h2 id="active-heading">Active</h2>
          <span>{view.active.length}</span>
        </div>

        {view.active.length > 0
          ? (
              <div className={styles.workspaceGrid}>
                {view.active.map((workspace) => (
                  <WorkspaceActivityCard workspace={workspace} now={view.now} key={workspace.cwd} />
                ))}
              </div>
            )
          : <p className={styles.empty}>No active workspaces.</p>}
      </section>

      {view.earlier.length > 0 && (
        <details className={styles.earlier}>
          <summary>
            <span>Earlier</span>
            <span>{view.earlier.length}</span>
          </summary>
          <div className={styles.workspaceGrid}>
            {view.earlier.map((workspace) => (
              <WorkspaceActivityCard workspace={workspace} now={view.now} key={workspace.cwd} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
