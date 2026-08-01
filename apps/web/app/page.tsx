import { runtimeRevisionFromEnvironment, validateNetworkEnvironment } from "@samurai-sushi/network";
import { CounterShell } from "./counter-shell";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const network = validateNetworkEnvironment(process.env);
  const runtimeRevision = runtimeRevisionFromEnvironment(process.env);
  return <CounterShell network={network} runtimeRevision={runtimeRevision} />;
}
