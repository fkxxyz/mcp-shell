import type { ToolCallStatusDto } from "../../../../../src/contracts/observability";
import styles from "./tool-call-status.module.css";

export function ToolCallStatus({ status }: { status: ToolCallStatusDto }) {
  return (
    <span
      className={styles.status}
      data-status={status}
      role="img"
      aria-label={statusLabel(status)}
    />
  );
}

function statusLabel(status: ToolCallStatusDto): string {
  if (status === "running") return "Running";
  if (status === "error") return "Error";
  return "Succeeded";
}
