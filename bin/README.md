# Command overrides

Executables in this directory form the repository command layer for MCP child processes.

Command lookup order is:

1. `~/.mcp-shell/bin` — user overrides
2. this directory — repository defaults and guardrails
3. the remaining tool/user/system `PATH`

Search commands `rg`, `find`, `fd`, and `grep` are wrapped with a default 200ms wall-clock budget. If a command exceeds that budget, the wrapper sends `SIGTERM`, escalates to `SIGKILL` after another 50ms, returns exit status 124, and emits `MCP_SEARCH_TIMEOUT`. Partial stdout/stderr produced before termination is preserved. If a broad search is only needed because location or context is unknown, report insufficient information instead of forcing a filesystem-wide scan. For an intentionally broad or slow search, add the wrapper-only `--unsafe` argument anywhere in the arguments; the wrapper removes it before invoking the real command.

The shared `_search-wrapper` resolves the underlying executable from the remaining `PATH` while skipping this repository directory, which avoids recursive wrapper invocation without hard-coding system-specific executable locations.

This layer is a command-behavior/guardrail mechanism, not a security boundary: callers with arbitrary shell execution can invoke an absolute executable path or otherwise bypass PATH lookup.
