import { Link } from "@tanstack/react-router";
import { formatClock, formatDuration } from "../../../lib/format";
import type { ActivityCallView } from "../activity-model";
import styles from "../activity.module.css";
import { formatToolCall } from "../format-tool-call";
import { ToolCallStatus } from "./ToolCallStatus";

export function ShellCallRow({ item }: { item: ActivityCallView }) {
  const { call, updateRevision } = item;
  const invocation = formatToolCall(call);
  const content = (
    <>
      {updateRevision > 0 && (
        <span className={styles.callUpdateFlash} key={updateRevision} aria-hidden="true" />
      )}
      <ToolCallStatus status={call.status} />
      <span className={styles.shellCallBody}>
        <strong className={styles.shellCallInvocation} title={invocation}>{invocation}</strong>
        <small>
          <time dateTime={call.started_at}>{formatClock(call.started_at)}</time>
        </small>
      </span>
      <span className={styles.shellCallDuration}>{formatDuration(call.duration_ms)}</span>
    </>
  );

  return call.status !== "running" && call.payload_available ? (
    <Link
      className={styles.shellCallRow}
      data-status={call.status}
      to="/tool-calls/$callId"
      params={{ callId: call.id }}
    >
      {content}
    </Link>
  ) : (
    <div className={styles.shellCallRow} data-status={call.status} aria-disabled="true">
      {content}
    </div>
  );
}
