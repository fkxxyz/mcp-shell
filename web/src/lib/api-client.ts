import type { ApiErrorDto } from "../../../src/contracts/activity";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function requestJson<T>(url: string | URL): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body as ApiErrorDto | null;
    throw new ApiError(
      response.status,
      error?.error?.code ?? "request_failed",
      error?.error?.message ?? `Request failed: ${response.status}`,
    );
  }
  return body as T;
}
