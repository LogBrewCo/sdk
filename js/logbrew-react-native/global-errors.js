import implementation from "./global-errors.cjs";

const {
  createLogBrewReactNativePromiseRejectionHandlers,
  installLogBrewReactNativeGlobalErrorHandler,
  installLogBrewReactNativePromiseRejectionTracker
} = implementation;

export {
  createLogBrewReactNativePromiseRejectionHandlers,
  installLogBrewReactNativeGlobalErrorHandler,
  installLogBrewReactNativePromiseRejectionTracker
};
export { default } from "./global-errors.cjs";
