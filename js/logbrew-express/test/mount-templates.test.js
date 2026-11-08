import { ANY_PORT, HOST, readField, serve } from "./support.js";
import assert from "node:assert/strict";
import { createRequestEvent } from "@logbrew/express";
import express from "express";
import test from "node:test";

/**
 * @import { TestContext } from "node:test"
 * @import { Express, Request, Response, Router } from "express"
 * @typedef {string | RegExp} MountPattern
 * @typedef {Readonly<{ mount: MountPattern, route: string, url: string }>} MountCase
 */

/**
 * @param {Request} req
 * @param {Response} res
 * @returns {void}
 */
function sendRequestName(req, res) {
  const attributes = readField(createRequestEvent(req, res), "attributes");
  res.json({ name: readField(attributes, "name") });
}

/**
 * @param {MountCase} mountCase
 * @returns {Express}
 */
function createMountedApp(mountCase) {
  const app = express();
  /** @type {Router} */
  const router = express.Router({ mergeParams: true });
  router.get(mountCase.route, sendRequestName);
  app.use(mountCase.mount, router);
  return app;
}

/**
 * @param {TestContext} testContext
 * @param {MountCase} mountCase
 * @returns {Promise<unknown>}
 */
async function requestName(testContext, mountCase) {
  const app = createMountedApp(mountCase);
  const server = await serve(testContext, () => app.listen(ANY_PORT, HOST));
  const response = await fetch(`${server.origin}${mountCase.url}`);
  return readField(await response.json(), "name");
}

await test("a RegExp mount never puts the matched record ID in the route template", async (testContext) => {
  const name = await requestName(testContext, { mount: /^\/u\/\d+/u, route: "/orders/:orderId", url: "/u/12345/orders/7" });

  assert.equal(name, "GET /orders/:orderId");
});

await test("a mount parameter whose value equals a literal segment keeps the declared pattern", async (testContext) => {
  const name = await requestName(testContext, { mount: "/tenants/:tenantId", route: "/orders/:orderId", url: "/tenants/tenants/orders/7" });

  assert.equal(name, "GET /tenants/:tenantId/orders/:orderId");
});

await test("a mount with an :id parameter names the parameter, not its value", async (testContext) => {
  const name = await requestName(testContext, { mount: "/accounts/:id", route: "/profile", url: "/accounts/42/profile" });

  assert.equal(name, "GET /accounts/:id/profile");
});
