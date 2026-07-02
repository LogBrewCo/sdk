import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { installLogBrewUndiciInstrumentation } = require("./undici.cjs");

export { installLogBrewUndiciInstrumentation };
