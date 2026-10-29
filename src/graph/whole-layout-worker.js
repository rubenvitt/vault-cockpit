// Rechnet das Layout des ganzen Vaults außerhalb des Haupt-Threads (src/graph/whole.js).
import { parentPort, workerData } from 'node:worker_threads';
import { computeLayout } from './whole-layout.js';

parentPort.postMessage(computeLayout(workerData));
