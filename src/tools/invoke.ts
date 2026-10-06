import type { Shell, ShellStore } from "../shell-store.js";
import type { ToolCallRecorder } from "../observability/tool-call-recorder.js";

export async function invokeShellTool<T>(
  recorder: ToolCallRecorder,
  shells: ShellStore,
  tool: string,
  input: Record<string, unknown>,
  execute: (shell: Shell) => Promise<T>,
): Promise<T> {
  const requestedShellId = input.shell_id;
  if (typeof requestedShellId !== "number" || !Number.isInteger(requestedShellId) || requestedShellId <= 0) {
    return recorder.run(
      { tool, input },
      async () => {
        throw new Error("shell_id must be a positive integer");
      },
    );
  }

  let shell: Shell;
  try {
    shell = shells.require(requestedShellId);
  } catch (error) {
    return recorder.run(
      {
        tool,
        input,
        shellId: requestedShellId,
      },
      async () => {
        throw error;
      },
    );
  }

  return recorder.run(
    {
      tool,
      input,
      shellId: shell.id,
      cwd: shell.cwd,
    },
    () => execute(shell),
  );
}
