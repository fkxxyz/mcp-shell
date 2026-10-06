import { Link } from "@tanstack/react-router";
import { formatRelativeTime } from "../../../lib/format";
import type { ActivityCallView } from "../activity-model";
import styles from "../activity.module.css";
import { formatToolCall } from "../format-tool-call";
import { ToolCallStatus } from "./ToolCallStatus";

export function ActivityCallRow({
  item,
  now,
}: {
  item: ActivityCallView;
  now: number;
}) {
  const { call, updateRevision } = item;
  const invocation = formatToolCall(call);
  const tool = call.status !== "running" && call.payload_available
    ? (
        <Link
          className={styles.callInvocation}
          to="/tool-calls/$callId"
          params={{ callId: call.id }}
          title={invocation}
        >
          {invocation}
        </Link>
      )
    : <span className={styles.callInvocation} title={invocation}>{invocation}</span>;

  return (
    <div className={styles.callRow} data-status={call.status}>
      {updateRevision > 0 && (
        <span className={styles.callUpdateFlash} key={updateRevision} aria-hidden="true" />
      )}
      <ToolCallStatus status={call.status} />
      {tool}
      {call.shell_id == null
        ? <span className={styles.callShell}>pending</span>
        : (
            <Link
              className={styles.callShell}
              to="/shells/$shellId"
              params={{ shellId: String(call.shell_id) }}
            >
              #{call.shell_id}
            </Link>
          )}
      <time
        className={styles.callTime}
        dateTime={call.finished_at ?? call.started_at}
      >
        {formatRelativeTime(call.finished_at ?? call.started_at, now)}
      </time>
    </div>
  );
}
