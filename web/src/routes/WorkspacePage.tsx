import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { activityQueryKeys, listWorkspaceShells } from "../features/activity/api";
import { basename, formatClock, formatRelativeTime } from "../lib/format";
import styles from "./routes.module.css";

export function WorkspacePage({ cwd }: { cwd: string }) {
  const query = useInfiniteQuery({
    queryKey: activityQueryKeys.workspaceShells(cwd),
    queryFn: ({ pageParam }) => listWorkspaceShells(cwd, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    enabled: Boolean(cwd),
  });

  if (!cwd) return <PageError title="Workspace" message="Missing workspace path." />;

  const shells = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className={styles.page}>
      <Link className={styles.back} to="/activity">← Activity</Link>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Workspace</p>
        <h1>{basename(cwd)}</h1>
        <p className={styles.path}>{cwd}</p>
      </header>

      {query.isPending && <p className={styles.muted}>Loading shells…</p>}
      {query.isError && <PageError title="Could not load shells" message={query.error.message} />}

      {!query.isPending && !query.isError && (
        <section className={styles.panel}>
          <div className={styles.list}>
            {shells.map((shell) => (
              <Link
                className={styles.listRow}
                to="/shells/$shellId"
                params={{ shellId: String(shell.shell_id) }}
                key={shell.shell_id}
              >
                <span>
                  <strong>shell #{shell.shell_id}</strong>
                  <small>Created {formatClock(shell.created_at)}</small>
                </span>
                <span className={styles.rowMeta}>
                  {shell.last_activity_at ? formatRelativeTime(shell.last_activity_at) : "no activity"}
                </span>
              </Link>
            ))}
            {shells.length === 0 && <p className={styles.muted}>No Shells found for this workspace.</p>}
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
