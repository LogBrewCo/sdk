import { withLogBrewRouteHandler } from "@logbrew/next";
import { logger, routeOptions } from "../../logger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withLogBrewRouteHandler(async (_request, _context, { setUser }) => {
  setUser("user_123");
  logger.warn("payment step failing");
  throw new Error("payment declined");
}, routeOptions("/api/fail"));
