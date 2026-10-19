const core = require("./core.cjs");
const winston = require("./winston.cjs");
const { installBrowserBreadcrumbs } = require("./browser-breadcrumbs.cjs");

module.exports = { ...core, ...winston, installBrowserBreadcrumbs };
