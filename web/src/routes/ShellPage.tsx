import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useShellActivityCalls } from "../features/activity/ActivityProvider";
import { mergeShellCallViews } from "../features/activity/activity-model";
import { activityQueryKeys, listShellCalls } from "../features/activity/api";
import { ShellCallRow } from "../features/activity/components/ShellCallRow";
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
  const liveCalls = useShellActivityCalls(validShellId ? shellId : -1);

  if (!validShellId) return <PageError title="Shell" message="Invalid Shell ID." />;

  const first = query.data?.pages[0];
  const history = query.data?.pages.flatMap((page) => page.items) ?? [];
  const calls = mergeShellCallViews(history, liveCalls);
  const showCallList = calls.length > 0 || (!query.isPending && !query.isError);

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

      {showCallList && (
        <section className={styles.panel}>
          <div className={styles.list}>
            {calls.map((item) => <ShellCallRow item={item} key={item.call.id} />)}
            {calls.length === 0 && !query.isPending && !query.isError && (
              <p className={styles.muted}>No retained calls for this Shell.</p>
            )}
          </div>
          {!query.isError && query.hasNextPage && (
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
