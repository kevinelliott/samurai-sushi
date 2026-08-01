import { resolve } from "node:path";
import { parseCommandRole, runProfiledCommand } from "./command-runner";

const projectRoot = resolve(import.meta.dirname, "..");
const role = parseCommandRole(process.argv[2]);
process.exitCode = await runProfiledCommand(projectRoot, role, process.env);
