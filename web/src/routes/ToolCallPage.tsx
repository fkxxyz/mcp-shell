import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { activityQueryKeys, getToolCall } from "../features/activity/api";
import { JsonDetail } from "../features/activity/components/JsonDetail";
import { formatClock, formatDuration } from "../lib/format";
import styles from "./routes.module.css";

export function ToolCallPage({ callId }: { callId: string }) {
  const query = useQuery({
    queryKey: activityQueryKeys.toolCall(callId),
    queryFn: () => getToolCall(callId),
    enabled: Boolean(callId),
    staleTime: Infinity,
  });

  return (
    <div className={styles.page}>
      <Link className={styles.back} to="/activity">← Activity</Link>

      {query.isPending && <p className={styles.muted}>Loading tool call…</p>}
      {query.isError && (
        <section className={styles.errorBox} role="alert">
          <strong>Could not load tool call</strong>
          <span>{query.error.message}</span>
        </section>
      )}

      {query.data && (
        <>
          <header className={styles.header}>
            <p className={styles.eyebrow}>Tool call</p>
            <h1>{query.data.tool}</h1>
            <p className={styles.path}>{query.data.cwd ?? "No workspace"}</p>
            <dl className={styles.metadata}>
              <div><dt>Status</dt><dd>{query.data.status}</dd></div>
              <div><dt>Started</dt><dd>{formatClock(query.data.started_at)}</dd></div>
              <div><dt>Duration</dt><dd>{formatDuration(query.data.duration_ms)}</dd></div>
              {query.data.shell_id != null && (
                <div>
                  <dt>Shell</dt>
                  <dd>
                    <Link to="/shells/$shellId" params={{ shellId: String(query.data.shell_id) }}>
                      #{query.data.shell_id}
                    </Link>
                  </dd>
                </div>
              )}
            </dl>
          </header>

          <section className={styles.panel}>
            <h2>Payload</h2>
            <JsonDetail value={query.data} />
          </section>
        </>
      )}
    </div>
  );
}
