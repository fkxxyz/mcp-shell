import express, { Router } from "express";
import { fileURLToPath } from "node:url";

const WEB_ROOT = fileURLToPath(new URL("../../web/", import.meta.url));

export function createActivityUiRouter(): Router {
  const router = Router();
  router.use(express.static(WEB_ROOT, {
    index: "index.html",
    fallthrough: false,
  }));
  return router;
}
