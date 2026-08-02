import { handleNextRoute } from "@samurai-sushi/account-http-runtime/next";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> { return handleNextRoute("deletion.submit", request); }
