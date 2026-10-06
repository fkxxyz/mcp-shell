import { Link, Outlet } from "@tanstack/react-router";
import { useActivityConnection } from "../features/activity/ActivityProvider";
import styles from "./app.module.css";

export function AppShell() {
  const connection = useActivityConnection();

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brandBlock}>
          <div className={styles.brand}>mcp-shell</div>
          <div className={styles.subtitle}>Web Console</div>
        </div>

        <nav className={styles.nav} aria-label="Console">
          <Link
            to="/activity"
            className={styles.navLink}
            activeProps={{ "aria-current": "page" }}
          >
            Activity
          </Link>
        </nav>

        <div className={styles.connection} data-state={connection}>
          <span className={styles.connectionDot} aria-hidden="true" />
          <span>{connectionLabel(connection)}</span>
        </div>
      </aside>

      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}

function connectionLabel(connection: ReturnType<typeof useActivityConnection>): string {
  if (connection === "live") return "Live";
  if (connection === "reconnecting") return "Reconnecting";
  return "Connecting";
}
