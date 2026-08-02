export const ACCOUNT_HTTP_ROUTES = Object.freeze([
  ["cookies.reset", "/api/account/cookies/reset"],
  ["guest.issue", "/api/account/guest/issue"],
  ["guest.resume", "/api/account/guest/resume"],
  ["guest.rotate", "/api/account/guest/rotate"],
  ["guest.delete", "/api/account/guest/delete"],
  ["guest.claim-capability.rotate", "/api/account/guest/claim-capability/rotate"],
  ["claim.challenge", "/api/account/claim/challenge"],
  ["claim.submit", "/api/account/claim"],
  ["recovery.challenge", "/api/account/claim/recovery/challenge"],
  ["recovery.submit", "/api/account/claim/recovery"],
  ["claim.delivery", "/api/account/claim/delivery"],
  ["player.authenticate", "/api/account/player/session"],
  ["player.rotate", "/api/account/player/session/rotate"],
  ["player.logout", "/api/account/player/logout"],
  ["deletion.challenge", "/api/account/player/deletion/challenge"],
  ["deletion.submit", "/api/account/player/deletion"],
  ["service.query", "/api/account/service"],
  ["service.command", "/api/account/service/command"],
  ["receipt.review.prepare", "/api/account/receipt/review/prepare"],
  ["receipt.review.restore", "/api/account/receipt/review/restore"],
  ["wallet.runtime.sync", "/api/account/wallet/runtime/sync"],
  ["wallet.link.challenge", "/api/account/wallet/link/challenge"],
  ["wallet.link.proof", "/api/account/wallet/link/proof"],
  ["wallet.link.disconnect", "/api/account/wallet/link/disconnect"],
  ["receipt.review.preflight", "/api/account/receipt/review/preflight"],
] as const);

export type AccountRouteId = typeof ACCOUNT_HTTP_ROUTES[number][0];
export const ACCOUNT_ROUTE_PATHS = new Map<AccountRouteId, string>(ACCOUNT_HTTP_ROUTES);
export const ACCOUNT_ROUTE_IDS = new Set<AccountRouteId>(ACCOUNT_HTTP_ROUTES.map(([id]) => id));
export const ACCOUNT_API_PREFIX = "/api/account/";
export const MAX_JSON_BODY_BYTES = 32_768;
export const RAW_HEADER_GUARD = "x-samurai-raw-header-guard";

export const PUBLIC_HTTP_FAILURES = Object.freeze({
  request: Object.freeze({ status: 400, body: Object.freeze({ code: "REQUEST_REJECTED", message: "The request could not be processed." }) }),
  guest: Object.freeze({ status: 401, body: Object.freeze({ code: "GUEST_SESSION_REJECTED", message: "The guest session could not be authenticated." }) }),
  serviceAuthentication: Object.freeze({ status: 401, body: Object.freeze({ code: "SERVICE_AUTHORITY_REJECTED", message: "Service access could not be authenticated." }) }),
  serviceCredentialRefreshed: Object.freeze({ status: 428, body: Object.freeze({ code: "SERVICE_CREDENTIAL_REFRESHED", message: "Service access was refreshed. Requery the saved service." }) }),
  service: Object.freeze({ status: 409, body: Object.freeze({ code: "SERVICE_REQUEST_REJECTED", message: "The saved service could not be updated." }) }),
  runtime: Object.freeze({ status: 503, body: Object.freeze({ code: "SERVICE_UNAVAILABLE", message: "The account service is unavailable." }) }),
  wallet: Object.freeze({ status: 409, body: Object.freeze({ code: "WALLET_ACCESS_REJECTED", message: "Wallet access could not be accepted." }) }),
  review: Object.freeze({ status: 409, body: Object.freeze({ code: "RECEIPT_REVIEW_REJECTED", message: "The optional receipt review could not be prepared." }) }),
  notFound: Object.freeze({ status: 404, body: Object.freeze({ code: "NOT_FOUND", message: "The requested review state is unavailable." }) }),
} as const);
