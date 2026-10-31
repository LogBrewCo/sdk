import { fileReference } from "./release-artifacts-common.js";
import path from "node:path";

const TRAILING_SLASHES_RE = /\/+$/u;
const LEADING_SLASHES_RE = /^\/+/u;
const URL_WITH_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;

/**
 * @param {Readonly<{ host: string, protocol: string }>} parsed
 * @param {string} pathname
 * @returns {string}
 */
function urlWithPath({ host, protocol }, pathname) {
  return host === "" ? `${protocol}//${pathname}` : `${protocol}//${host}${pathname}`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeUrlOrPath(value) {
  const trimmed = value.trim();
  if (URL_WITH_SCHEME_RE.test(trimmed)) {
    const { host, pathname, protocol } = new URL(trimmed);
    const normalizedPath = path.posix.normalize(pathname === "" ? "/" : pathname).replace(TRAILING_SLASHES_RE, "");
    return urlWithPath({ host, protocol }, normalizedPath === "" ? "/" : normalizedPath);
  }
  return fileReference(trimmed).trim().replace(TRAILING_SLASHES_RE, "");
}

/**
 * @param {string} prefix
 * @param {string} relativePath
 * @returns {string}
 */
function joinUrlOrPath(prefix, relativePath) {
  const normalizedPrefix = normalizeUrlOrPath(prefix);
  const normalizedRelative = relativePath.replaceAll("\\", "/").replace(LEADING_SLASHES_RE, "");
  if (URL_WITH_SCHEME_RE.test(normalizedPrefix)) {
    const { host, pathname, protocol } = new URL(normalizedPrefix);
    const joinedPath = path.posix.join(pathname.replace(TRAILING_SLASHES_RE, ""), normalizedRelative);
    return urlWithPath({ host, protocol }, joinedPath.startsWith("/") ? joinedPath : `/${joinedPath}`);
  }
  return normalizedPrefix === ""
    ? normalizedRelative
    : `${normalizedPrefix.replace(TRAILING_SLASHES_RE, "")}/${normalizedRelative}`;
}

export { joinUrlOrPath, normalizeUrlOrPath };
