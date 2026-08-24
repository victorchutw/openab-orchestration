import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const waitState = new Int32Array(new SharedArrayBuffer(4));
const activeDatabasePath = join(workerData.primaryRoot, "runtime-core.sqlite3");

parentPort.postMessage({ status: "ready" });

for (;;) {
  let candidateExists = false;
  try {
    candidateExists = readdirSync(workerData.primaryRoot).some((name) =>
      name.startsWith(".restore-candidate-"),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (candidateExists) {
    try {
      mkdirSync(activeDatabasePath);
      parentPort.postMessage({ status: "obstructed" });
    } catch (error) {
      parentPort.postMessage({ status: "failed", code: error?.code });
    }
    break;
  }
  Atomics.wait(waitState, 0, 0, 1);
}
