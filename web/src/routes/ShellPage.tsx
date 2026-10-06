import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { activityQueryKeys, listShellCalls } from "../features/activity/api";
import { formatToolCall } from "../features/activity/format-tool-call";
import { formatClock, formatDuration } from "../lib/format";
import styles from "./routes.module.css";

export function ShellPage({ shellId }: { shellId: number }) {
  const validShellId = Number.isInteger(shellId) && shellId > 0;
  const query = useInfiniteQuery({
    queryKey: activityQueryKeys.shellCalls(shellId),
    queryFn: ({ pageParam }) => listShellCalls(shellId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    enabled: validShellId,
  });

  if (!validShellId) return <PageError title="Shell" message="Invalid Shell ID." />;

  const first = query.data?.pages[0];
  const calls = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className={styles.page}>
      <Link className={styles.back} to="/activity">← Activity</Link>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Shell</p>
        <h1>shell #{shellId}</h1>
        {first?.shell.cwd && <p className={styles.path}>{first.shell.cwd}</p>}
      </header>

      {query.isPending && <p className={styles.muted}>Loading calls…</p>}
      {query.isError && <PageError title="Could not load Shell" message={query.error.message} />}

      {!query.isPending && !query.isError && (
        <section className={styles.panel}>
          <div className={styles.list}>
            {calls.map((call) => {
              const invocation = formatToolCall(call);
              const content = (
                <>
                  <span>
                    <strong className={styles.callInvocation} title={invocation}>{invocation}</strong>
                    <small>{formatClock(call.started_at)} · {call.status}</small>
                  </span>
                  <span className={styles.rowMeta}>{formatDuration(call.duration_ms)}</span>
                </>
              );
              return call.payload_available ? (
                <Link
                  className={styles.listRow}
                  to="/tool-calls/$callId"
                  params={{ callId: call.id }}
                  key={call.id}
                >
                  {content}
                </Link>
              ) : (
                <div className={styles.listRow} aria-disabled="true" key={call.id}>
                  {content}
                </div>
              );
            })}
            {calls.length === 0 && <p className={styles.muted}>No retained calls for this Shell.</p>}
          </div>
          {query.hasNextPage && (
            <button
              className={styles.loadMore}
              type="button"
              onClick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

function PageError({ title, message }: { title: string; message: string }) {
  return (
    <section className={styles.errorBox} role="alert">
      <strong>{title}</strong>
      <span>{message}</span>
    </section>
  );
}
