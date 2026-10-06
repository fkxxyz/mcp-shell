export function basename(path) {
  const trimmed = String(path).replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) || "/" : trimmed;
}

export function formatRelativeTime(value, now = Date.now()) {
  const time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return "";
  const value = Number(ms);
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

export function statusText(call) {
  if (call.status === "running") return "running…";
  if (call.status === "error") return call.duration_ms == null ? "error" : `error · ${formatDuration(call.duration_ms)}`;
  return call.duration_ms == null ? "done" : formatDuration(call.duration_ms);
}
