import type { IncomingMessage, ServerResponse } from "node:http";
import { handle } from "../src/server.ts";

// Vercel entry. vercel.json rewrites every /api/<anything> here as /api/index?__p=<anything>; we restore the
// original path so the very same handler that `npm start` uses can route it.
export default function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.searchParams.get("__p");
  if (p !== null) {
    url.searchParams.delete("__p");
    req.url = `/api/${p}${url.search}`;
  }
  return handle(req, res);
}
