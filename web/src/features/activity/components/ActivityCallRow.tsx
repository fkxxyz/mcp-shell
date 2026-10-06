import { Link } from "@tanstack/react-router";
import type { ToolCallSummaryDto } from "../../../../../src/contracts/activity";
import { formatRelativeTime } from "../../../lib/format";
import styles from "../activity.module.css";
import { formatToolCall } from "../format-tool-call";

export function ActivityCallRow({
  call,
  now,
}: {
  call: ToolCallSummaryDto;
  now: number;
}) {
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
    <div className={styles.callRow}>
      <span
        className={styles.callState}
        data-status={call.status}
        role="img"
        aria-label={statusLabel(call.status)}
      />
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

function statusLabel(status: ToolCallSummaryDto["status"]): string {
  if (status === "running") return "Running";
  if (status === "error") return "Error";
  return "Succeeded";
}
