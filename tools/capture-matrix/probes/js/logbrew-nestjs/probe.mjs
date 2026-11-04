import "reflect-metadata";
import { ConsoleLogger, Controller, Get, Logger, Module, Req, UseGuards } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createNodeFetchTransport } from "@logbrew/node";
import { createLogBrewNestClient, createLogBrewNestLogger, LogBrewInterceptor } from "@logbrew/nestjs";

process.env.LOGBREW_RELEASE = "checkout@1.2.3";
process.env.LOGBREW_ENVIRONMENT = "production";
process.env.LOGBREW_SERVICE_NAME = "checkout-api";

const logger = new Logger("Checkout");

class AuthGuard {
  canActivate(context) {
    context.switchToHttp().getRequest().logbrew?.setUser("user_123");
    return true;
  }
}

class CheckoutController {
  checkout() {
    logger.log("checkout started");
    return { ok: true };
  }

  fail() {
    logger.warn("payment step failing");
    throw new Error("payment declined");
  }
}
Controller()(CheckoutController);
UseGuards(new AuthGuard())(CheckoutController);
for (const [method, path] of [["checkout", "/checkout/:cartId"], ["fail", "/fail/:cartId"]]) {
  const descriptor = Object.getOwnPropertyDescriptor(CheckoutController.prototype, method);
  Get(path)(CheckoutController.prototype, method, descriptor);
  Req()(CheckoutController.prototype, method, 0);
}
class AppModule {}
Module({ controllers: [CheckoutController] })(AppModule);

const app = await NestFactory.create(AppModule, { logger: false });
const transport = createNodeFetchTransport({ endpoint: process.env.LOGBREW_CAPTURE_ENDPOINT });
const client = createLogBrewNestClient({ serverApiKey: "LOGBREW_SERVER_API_KEY", sdkName: "checkout-api", sdkVersion: "1.2.3" });
const nestLogger = createLogBrewNestLogger({ client, transport, baseLogger: new ConsoleLogger("LogBrew") });
app.useLogger(nestLogger);
app.useGlobalInterceptors(new LogBrewInterceptor({ client, transport, captureRequestMetrics: true }));
await app.listen(0, "127.0.0.1");

const base = await app.getUrl();
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
await (await fetch(`${base}/checkout/cart-1`, { headers: { traceparent } })).text();
await (await fetch(`${base}/fail/cart-2`, { headers: { traceparent } })).text();
await new Promise((resolve) => setTimeout(resolve, 500));
await app.close();
await nestLogger.flush();
await client.shutdown(transport);
