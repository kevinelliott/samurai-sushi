import { startAccountNextServer } from "@samurai-sushi/account-http-runtime/server";

const port = Number(process.env.PORT ?? "3000");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port.");

async function main(): Promise<void> {
  const server = await startAccountNextServer({
    appRoot: process.cwd(),
    port,
    hostname: "127.0.0.1",
    dev: process.env.NODE_ENV !== "production",
    environment: process.env,
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => { void server.closeAll().finally(() => { process.exitCode = 0; }); });
  }
}

void main().catch(() => { process.exitCode = 1; });
