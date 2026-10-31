import plugin from "./expo.cjs";

const { modifyPodfile, withLogBrewReactNative } = plugin;

export { modifyPodfile, withLogBrewReactNative };
export default withLogBrewReactNative;
