import type {
  LogBrewNextRequestErrorHandler,
  LogBrewNextRequestErrorOptions
} from "./index.cjs";

export type {
  LogBrewNextRequestError,
  LogBrewNextRequestErrorCaptureContext,
  LogBrewNextRequestErrorContext,
  LogBrewNextRequestErrorEvent,
  LogBrewNextRequestErrorHandler,
  LogBrewNextRequestErrorInput,
  LogBrewNextRequestErrorOptions,
  LogBrewNextRequestErrorRequest,
  LogBrewNextRequestErrorRuntimeContext
} from "./index.cjs";

export declare function createLogBrewNextRequestErrorHandler(
  options?: LogBrewNextRequestErrorOptions
): LogBrewNextRequestErrorHandler;

declare const defaultExport: {
  createLogBrewNextRequestErrorHandler: typeof createLogBrewNextRequestErrorHandler;
};

export default defaultExport;
