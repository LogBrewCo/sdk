const config = {
  dependency: {
    platforms: {
      android: {
        packageImportPath: "import co.logbrew.reactnative.LogBrewReactNativePackage;",
        packageInstance: "new LogBrewReactNativePackage()"
      },
      ios: {}
    }
  }
};

export default config;
