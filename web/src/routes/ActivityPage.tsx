import type { ReactNode } from "react";
import { useActivityView } from "../features/activity/ActivityProvider";
import { WorkspaceCard } from "../features/activity/components/WorkspaceCard";
import styles from "../features/activity/activity.module.css";

export function ActivityPage() {
  const view = useActivityView();

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>Observability</p>
          <h1>Activity</h1>
          <p>Live tool activity grouped by Shell root.</p>
        </div>
      </header>

      <ActivitySection
        title="Active"
        empty="No activity in the last 10 minutes."
        count={view.active.length}
      >
        {view.active.map((workspace) => (
          <WorkspaceCard workspace={workspace} now={view.now} key={workspace.cwd} />
        ))}
      </ActivitySection>

      <ActivitySection
        title="Earlier"
        empty="No earlier activity."
        count={view.earlier.length}
      >
        {view.earlier.map((workspace) => (
          <WorkspaceCard workspace={workspace} now={view.now} compact key={workspace.cwd} />
        ))}
      </ActivitySection>
    </div>
  );
}

function ActivitySection({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: ReactNode;
}) {
  const id = `section-${title.toLowerCase()}`;
  return (
    <section className={styles.activitySection} aria-labelledby={id}>
      <div className={styles.sectionHeading}>
        <h2 id={id}>{title}</h2>
        <span>{count}</span>
      </div>
      {count > 0 ? <div className={styles.workspaceList}>{children}</div> : <p className={styles.empty}>{empty}</p>}
    </section>
  );
}
