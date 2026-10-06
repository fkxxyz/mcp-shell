import express, { Router, type Response } from "express";
import { access } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function isCompiledServerRuntime(): boolean {
  return basename(RUNTIME_ROOT) === "server" && basename(dirname(RUNTIME_ROOT)) === "dist";
}

export function defaultWebRoot(): string {
  return isCompiledServerRuntime()
    ? resolve(RUNTIME_ROOT, "../web")
    : resolve(RUNTIME_ROOT, "dist/web");
}

export async function assertWebUiBuild(webRoot: string): Promise<void> {
  try {
    await access(join(webRoot, "index.html"));
  } catch (error) {
    throw new Error(`Web Console is enabled but its build is missing at ${webRoot}. Run npm run build.`, { cause: error });
  }
}

export function createWebUiRouter(webRoot: string): Router {
  const router = Router();
  const indexFile = join(webRoot, "index.html");

  router.use("/assets", express.static(join(webRoot, "assets"), {
    fallthrough: true,
    immutable: true,
    index: false,
    maxAge: "1y",
  }));
  router.use("/assets", (_req, res) => {
    res.status(404).type("text").send("Not found");
  });

  const sendIndex = (res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(indexFile);
  };

  router.get("/", (_req, res) => sendIndex(res));
  router.get("/index.html", (_req, res) => sendIndex(res));
  router.get(/.*/, (_req, res) => sendIndex(res));
  return router;
}
