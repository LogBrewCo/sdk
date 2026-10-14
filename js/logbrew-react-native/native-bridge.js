import runtime from "./native-bridge.cjs";

export const {
  clearLogBrewNativeBridgeScope,
  createLogBrewNativeBridgeScope,
  syncLogBrewNativeBridgeScope,
  withLogBrewNativeBridgeScope,
  withLogBrewNativeBridgeScopeAsync
} = runtime;

export default runtime.default;
