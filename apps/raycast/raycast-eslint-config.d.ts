declare module "@raycast/eslint-config" {
  import type { Linter } from "eslint";

  const config: readonly Linter.Config[];
  export = config;
}
