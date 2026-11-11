// Payload executed inside the isolated JavaScript sandbox, never on the host.
import { readFile } from "node:fs/promises";
const [programPath, statePath, manifestPath] = process.argv.slice(2);
const [code, state, manifest] = await Promise.all([
  readFile(programPath, "utf8"),
  readFile(statePath, "utf8").then(JSON.parse),
  readFile(manifestPath, "utf8").then(JSON.parse),
]);
let callIndex = 0;
const stable = (value) => {
  const normalize = (candidate) => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(Object.keys(candidate).sort().map((key) => [key, normalize(candidate[key])]));
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
};
const forge = Object.freeze({
  call: async (capabilityId, input, options = {}) => {
    const declaration = manifest.find((entry) => entry.id === capabilityId);
    if (!declaration) throw new Error("Capability is not declared: " + capabilityId);
    const used = state.calls.slice(0, callIndex).filter((call) => call.capabilityId === capabilityId).length;
    if (used >= declaration.maximumCalls) throw new Error("Capability call limit exceeded: " + capabilityId);
    const previous = state.calls[callIndex];
    if (previous) {
      if (previous.capabilityId !== capabilityId || stable(previous.input) !== stable(input) || previous.idempotencyKey !== options.idempotencyKey) {
        throw new Error("Program replay diverged at call " + callIndex);
      }
      callIndex += 1;
      return previous.result;
    }
    console.log("__FORGE_CALL__" + JSON.stringify({callIndex, capabilityId, input, idempotencyKey: options.idempotencyKey}));
    process.exitCode = 42;
    throw new Error("FORGE_CALL_PENDING");
  },
});
try {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const result = await new AsyncFunction("forge", '"use strict";\n' + code)(forge);
  console.log("__FORGE_OUTPUT__" + JSON.stringify({result}));
} catch (error) {
  if (error?.message !== "FORGE_CALL_PENDING") throw error;
}
