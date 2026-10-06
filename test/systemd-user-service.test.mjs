import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import {
  MANAGED_MARKER,
  checkService,
  effectivePropertyErrors,
  installService,
  isManagedUnit,
  parseRenderedExecStart,
  parseSystemctlShow,
  quoteSystemdExecArgument,
  renderUnit,
  userUnitPath,
} from "../scripts/systemd-user-service.mjs";

const template = `${MANAGED_MARKER}\n[Service]\nExecStart=@@NODE@@ @@ENTRYPOINT@@\n`;

test("renders a self-contained managed unit and round-trips special path characters", () => {
  const nodePath = '/opt/node path/$current%/node"x';
  const entrypoint = '/srv/mcp shell/dist/server/main $100%.js';
  const rendered = renderUnit(template, { nodePath, entrypoint });

  assert.equal(isManagedUnit(rendered), true);
  assert.deepEqual(parseRenderedExecStart(rendered), { nodePath, entrypoint });
  assert.match(rendered, /\$\$/);
  assert.match(rendered, /%%/);
  assert.match(rendered, /\\"/);
});

test("rejects unsafe ExecStart argument contents", () => {
  assert.throws(() => quoteSystemdExecArgument("a\nb"), /cannot contain/);
  assert.throws(() => quoteSystemdExecArgument(""), /non-empty/);
});

test("uses XDG_CONFIG_HOME for the user unit when configured", () => {
  assert.equal(
    userUnitPath({ home: "/home/user", env: { XDG_CONFIG_HOME: "/custom/config" } }),
    "/custom/config/systemd/user/mcp-shell.service",
  );
  assert.equal(
    userUnitPath({ home: "/home/user", env: {} }),
    "/home/user/.config/systemd/user/mcp-shell.service",
  );
  assert.throws(
    () => userUnitPath({ home: "/home/user", env: { XDG_CONFIG_HOME: "relative/config" } }),
    /XDG_CONFIG_HOME must be absolute/,
  );
});

test("parses and validates effective lifecycle properties", () => {
  const output = [
    "LoadState=loaded",
    "Type=simple",
    "KillSignal=15",
    "KillMode=mixed",
    "SendSIGKILL=yes",
    "TimeoutStopUSec=15s",
    "Restart=on-failure",
    "RestartUSec=5s",
    "NeedDaemonReload=no",
    "FragmentPath=/tmp/mcp-shell.service",
    "",
  ].join("\n");
  const properties = parseSystemctlShow(output);
  assert.deepEqual(effectivePropertyErrors(properties, "/tmp/mcp-shell.service"), []);

  properties.KillMode = "control-group";
  properties.TimeoutStopUSec = "1min 30s";
  assert.deepEqual(effectivePropertyErrors(properties, "/tmp/mcp-shell.service"), [
    "KillMode: expected mixed, got control-group",
    "TimeoutStopUSec: expected 15s, got 1min 30s",
  ]);
});

test("installer refuses unmanaged units unless replacement is explicit", async () => {
  const fixture = await createFixture();
  await mkdir(join(fixture.home, ".config", "systemd", "user"), { recursive: true });
  await writeFile(fixture.target, "[Service]\nExecStart=/bin/false\n");

  await assert.rejects(
    installService(fixture.options()),
    /Refusing to replace unmanaged systemd unit/,
  );
  assert.equal(fixture.systemctlCalls.length, 0);

  await installService(fixture.options({ replaceExisting: true }));
  assert.equal(isManagedUnit(await readFile(fixture.target, "utf8")), true);
  assert.deepEqual(await readdir(join(fixture.home, ".config", "systemd", "user")), ["mcp-shell.service"]);
  assert.deepEqual(fixture.systemctlCalls, [["--user", "daemon-reload"]]);
});

test("check validates installed paths and effective systemd state without requiring service activity", async () => {
  const fixture = await createFixture();
  await installService(fixture.options());
  fixture.systemctlCalls.length = 0;

  const effective = [
    "LoadState=loaded",
    "Type=simple",
    "KillSignal=15",
    "KillMode=mixed",
    "SendSIGKILL=yes",
    "TimeoutStopUSec=15s",
    "Restart=on-failure",
    "RestartUSec=5s",
    "NeedDaemonReload=no",
    `FragmentPath=${fixture.target}`,
    "",
  ].join("\n");
  const checked = await checkService(fixture.options({
    runSystemctl: async (args) => {
      fixture.systemctlCalls.push(args);
      return effective;
    },
  }));

  assert.equal(checked.entrypoint, fixture.entrypoint);
  assert.equal(fixture.systemctlCalls.length, 1);
  assert.equal(fixture.systemctlCalls[0][0], "--user");
  assert.equal(fixture.systemctlCalls[0][1], "show");
});

test("canonical template keeps deployment policy narrow", async () => {
  const source = await readFile(new URL("../deploy/systemd/mcp-shell.service.in", import.meta.url), "utf8");
  assert.match(source, /^# Managed by mcp-shell/m);
  assert.match(source, /^Type=simple$/m);
  assert.match(source, /^Restart=on-failure$/m);
  assert.match(source, /^RestartSec=5s$/m);
  assert.match(source, /^KillSignal=SIGTERM$/m);
  assert.match(source, /^KillMode=mixed$/m);
  assert.match(source, /^SendSIGKILL=yes$/m);
  assert.match(source, /^TimeoutStopSec=15s$/m);
  assert.doesNotMatch(source, /^WorkingDirectory=/m);
  assert.doesNotMatch(source, /^After=network\.target$/m);
  assert.equal((source.match(/@@NODE@@/g) ?? []).length, 1);
  assert.equal((source.match(/@@ENTRYPOINT@@/g) ?? []).length, 1);
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "mcp-shell-systemd-"));
  const repoRoot = join(root, "repo");
  const home = join(root, "home");
  const nodePath = join(root, "node executable");
  const entrypoint = join(repoRoot, "dist", "server", "mcp-shell.js");
  const target = join(home, ".config", "systemd", "user", "mcp-shell.service");
  const systemctlCalls = [];

  await mkdir(join(repoRoot, "deploy", "systemd"), { recursive: true });
  await mkdir(join(repoRoot, "dist", "server"), { recursive: true });
  await writeFile(join(repoRoot, "deploy", "systemd", "mcp-shell.service.in"), template);
  await writeFile(nodePath, "#!/bin/sh\n");
  await chmod(nodePath, 0o700);
  await writeFile(entrypoint, "// compiled\n");

  return {
    home,
    entrypoint,
    target,
    systemctlCalls,
    options(overrides = {}) {
      return {
        repoRoot,
        home,
        env: {},
        nodePath,
        target,
        runSystemctl: async (args) => {
          systemctlCalls.push(args);
          return "";
        },
        ...overrides,
      };
    },
  };
}
