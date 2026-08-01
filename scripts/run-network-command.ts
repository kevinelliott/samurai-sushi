import { resolve } from "node:path";
import { parseCommandRole, parseNetworkName, runNetworkCommand } from "./command-runner";

const projectRoot = resolve(import.meta.dirname, "..");
const network = parseNetworkName(process.argv[2]);
const role = parseCommandRole(process.argv[3]);
process.exitCode = await runNetworkCommand(projectRoot, network, role);
