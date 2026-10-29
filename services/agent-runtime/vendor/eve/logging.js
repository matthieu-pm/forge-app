// Forge FOR-29: keep framework diagnostics free of model/provider payloads.
// This patch is pinned to EVE 0.31.0 and exercised against its real logger.
import { SpanStatusCode, trace } from "#compiled/@opentelemetry/api/index.js";

const LEVEL_SEVERITY = { debug: 10, info: 20, warn: 30, error: 40 };
const uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
let logRecordSubscriber;

function createErrorId() { return crypto.randomUUID(); }
function formatError(_error, errorId) {
  return {
    errorId: uuid(errorId) ? errorId : createErrorId(),
    name: "RuntimeError",
    message: "Runtime execution failed.",
    detail: "Private error details omitted.",
  };
}
function inspectError(_error) { return "Private error details omitted."; }
function extractErrorId(details) {
  return details && typeof details === "object" && uuid(details.errorId) ? details.errorId : undefined;
}
function formatErrorHint(_event) { return " (Runtime execution failed.)"; }
function recordErrorOnSpan(span, _error) {
  span.setStatus({ code: SpanStatusCode.ERROR, message: "Runtime execution failed." });
  span.recordException({ name: "RuntimeError", message: "Runtime execution failed." });
}
function isLogLevelEnabled(level) {
  const configured = process.env.EVE_LOG_LEVEL?.toLowerCase();
  return LEVEL_SEVERITY[level] >= (LEVEL_SEVERITY[configured] ?? LEVEL_SEVERITY.info);
}
function renderFields(fields) {
  const safe = {};
  if (!fields || typeof fields !== "object") return safe;
  for (const key of ["errorId", "sessionId", "turnId", "runId"]) {
    if (uuid(fields[key])) safe[key] = fields[key];
  }
  for (const key of ["statusCode", "attempt", "durationMs"]) {
    const value = fields[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) safe[key] = value;
  }
  if (fields.error !== undefined) safe.error = formatError(null, extractErrorId(fields.error));
  return safe;
}
function write(level, _namespace, _message, fields) {
  if (!isLogLevelEnabled(level)) return;
  const safe = renderFields(fields);
  // Neither namespace nor message is assumed to be authored by the framework.
  const record = { level, namespace: "runtime", message: "Runtime diagnostic.", fields: safe };
  if (logRecordSubscriber) {
    try { logRecordSubscriber(record); return; } catch { /* safe console fallback */ }
  }
  const output = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  output(`[eve:runtime] ${level}`, safe);
}
function createLogger(namespace) {
  return Object.fromEntries(Object.keys(LEVEL_SEVERITY).map(level => [level, (message, fields) => {
    write(level, namespace, message, fields);
    if (level === "error") {
      const span = trace.getActiveSpan();
      if (span) recordErrorOnSpan(span, null);
    }
  }]));
}
function logError(logger, _message, _error, fields) {
  const error = formatError(null);
  logger.error("Runtime execution failed.", { ...renderFields(fields), error });
  return error.errorId;
}
function setLogRecordSubscriber(subscriber) { logRecordSubscriber = subscriber; }

export { createErrorId, createLogger, extractErrorId, formatError, formatErrorHint, inspectError, isLogLevelEnabled, logError, recordErrorOnSpan, setLogRecordSubscriber };
