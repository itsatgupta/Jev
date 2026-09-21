import type { IncomingMessage, ServerResponse } from "node:http";
import { handle } from "../src/server.ts";

// Vercel entry: every /api/* request is served by the same handler that `npm start` uses locally.
export default function handler(req: IncomingMessage, res: ServerResponse) {
  return handle(req, res);
}
