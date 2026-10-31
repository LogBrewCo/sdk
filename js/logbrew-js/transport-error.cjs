class TransportError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {boolean} [retryable]
   */
  constructor(code, message, retryable = false) {
    super(message);
    this.name = "TransportError";
    this.code = code;
    this.retryable = retryable;
  }

  /**
   * @param {string} message
   * @returns {TransportError}
   */
  static network(message) {
    return new TransportError("network_failure", message, true);
  }
}

module.exports = { TransportError };
