import runtime from "./native-bridge.cjs";

export const {
  clearLogBrewNativeBridgeScope,
  createLogBrewNativeBridgeScope,
  syncLogBrewNativeBridgeScope,
  withLogBrewNativeBridgeScope
} = runtime;

export default runtime.default;
