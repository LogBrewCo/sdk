const core = require("./core.cjs");
const winston = require("./winston.cjs");

module.exports = { ...core, ...winston };
