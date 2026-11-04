import { withLogBrewRouteHandler } from "@logbrew/next";
import { logger, routeOptions } from "../../logger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withLogBrewRouteHandler(async (_request, _context, { setUser }) => {
  setUser("user_123");
  logger.info("checkout started");
  return Response.json({ ok: true });
}, routeOptions("/api/checkout"));
