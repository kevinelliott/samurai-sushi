"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseBrowserSafeReceiptReviewProjection, RECEIPT_REVIEW_STATE_MEANINGS,
  type BrowserSafeReceiptReviewProjectionV1 } from "@samurai-sushi/receipt-lifecycle";
import { parseReceiptReviewDoorway, parseReceiptReviewPreflightResult, parseWalletAccessView, parseWalletReviewCopy, parseWalletRuntimeSyncView,
  runtimeDriftPresentation, WALLET_REVIEW_COPY, type ReceiptReviewDoorwayView,
  type ReceiptReviewPreflightResult, type WalletAccessView, type WalletRuntimePort, type WalletRuntimeSyncView,
  type WalletReviewCopy } from "@samurai-sushi/wallet-link";
import { RECEIPT_REVIEW_PREFLIGHT_PATH, RECEIPT_REVIEW_PREPARE_PATH, RECEIPT_REVIEW_RESTORE_PATH,
  WALLET_RUNTIME_DISCONNECT_PATH, WALLET_RUNTIME_SYNC_PATH, postJson } from "./service-browser";

const FEE = "Not estimated in this phase. 0 mutez is the amount attached to the future contract call, not a network-fee estimate.";
const WOULD_PROVE = "If later submitted and accepted, this receipt would prove only that the displayed contract accepted one authorized, unexpired, single-use permit for this account and opaque service commitment under the displayed manifest and issuer policy.";
const WOULD_NOT_PROVE = "It would not reveal or independently verify the private service details. It would not represent ownership of the restaurant, dishes, recipes, ingredients, artwork, or game content; it is not transferable, scarce, redeemable, a progression reward, or evidence of financial value.";
const PRIVACY = "If a later phase submits this receipt, the wallet account, opaque commitment, content version, nonce, payload hash, operation, and chain timestamps may become public. Guest or player IDs, orders, choices, dialogue, score, wallet proof, and accessibility settings are not included.";
type ReviewPhase = "closed" | "loading" | "access" | "requesting" | "review" | "preflight" | "unavailable";

function requestId(): string {
  if (typeof crypto.randomUUID !== "function") throw new TypeError("Secure request generation is unavailable.");
  return crypto.randomUUID();
}
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  throw new TypeError("Review facts are unavailable.");
}
async function sha256(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join("");
}
async function developmentBarrier(boundary: 1): Promise<void> {
  if (process.env.NODE_ENV !== "development") return;
  const barrier = (window as unknown as { __samuraiReceiptReviewTestBarrier?: (name: number) => Promise<void> })
    .__samuraiReceiptReviewTestBarrier;
  if (barrier) await barrier(boundary);
}
function shortened(value: string): string { return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value; }
function plain(value: unknown, keys: readonly string[], message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length) throw new TypeError(message);
  const descriptors = Object.getOwnPropertyDescriptors(value); const actual = Object.getOwnPropertyNames(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])
    || actual.some((key) => !descriptors[key]?.enumerable || !("value" in descriptors[key]!))) throw new TypeError(message);
  return value as Record<string, unknown>;
}
function restoreBody(value: unknown): Readonly<{ accessPresentation: WalletReviewCopy; doorway: ReceiptReviewDoorwayView;
  projection: unknown | null; walletAccess: WalletAccessView | null }> {
  const row = plain(value, ["accessPresentation", "doorway", "projection", "schemaVersion", "walletAccess"], "Review restore is unavailable.");
  if (row.schemaVersion !== 1 || row.projection === undefined || row.walletAccess === undefined) throw new TypeError("Review restore is unavailable.");
  return Object.freeze({ doorway: parseReceiptReviewDoorway(row.doorway), projection: row.projection,
    walletAccess: row.walletAccess === null ? null : parseWalletAccessView(row.walletAccess),
    accessPresentation: parseWalletReviewCopy(row.accessPresentation) });
}
function preparedBody(value: unknown): BrowserSafeReceiptReviewProjectionV1 {
  const row = plain(value, ["projection", "schemaVersion"], "Receipt preparation is unavailable.");
  if (row.schemaVersion !== 1) throw new TypeError("Receipt preparation is unavailable.");
  return parseBrowserSafeReceiptReviewProjection(row.projection);
}
function durableWalletAccess(value: WalletRuntimeSyncView): value is WalletAccessView {
  return !("accessScope" in value);
}

function CopyFact({ label, value, generationToken, compact = false, commit }: Readonly<{
  label: string; value: string; generationToken: number; compact?: boolean;
  commit: (token: number, announcement?: string) => boolean;
}>) {
  const [copied, setCopied] = useState(false);
  return <div className="review-fact"><dt>{label}</dt><dd><span className="selectable-fact" title={compact ? value : undefined}>{compact ? <><span aria-hidden="true">{shortened(value)}</span><span className="sr-only">{value}</span></> : value}</span>
    <button type="button" className="copy-action" aria-label={`Copy full ${label.toLowerCase()}`} onClick={() => {
      const token = generationToken;
      void navigator.clipboard.writeText(value).then(() => {
        if (!commit(token, `${label} copied.`)) return; setCopied(true);
        window.setTimeout(() => { if (commit(token)) setCopied(false); }, 1_500);
      }).catch(() => undefined);
    }}>{copied ? "Copied" : "Copy"}</button></dd></div>;
}
function Status({ copy, headingRef }: Readonly<{ copy: WalletReviewCopy; headingRef: React.RefObject<HTMLHeadingElement | null> }>) {
  return <section className={`review-status is-${copy.tone}`} role={copy.tone === "blocking" ? "alert" : undefined}>
    <h3 ref={headingRef} tabIndex={-1}>{copy.title}</h3><p>{copy.message}</p>
  </section>;
}
function ReceiptFacts({ projection, doorway, generationToken, commit }: Readonly<{
  projection: BrowserSafeReceiptReviewProjectionV1; doorway: ReceiptReviewDoorwayView; generationToken: number;
  commit: (token: number, announcement?: string) => boolean;
}>) {
  const facts = projection.reviewFacts;
  return <div className="receipt-facts">
    <section aria-labelledby="receipt-account"><h3 id="receipt-account">Receipt account</h3><dl><CopyFact label="Account" value={facts.owner} compact generationToken={generationToken} commit={commit} /><div className="review-fact"><dt>Equality</dt><dd>Owner and source match exactly</dd></div></dl></section>
    <section aria-labelledby="receipt-network"><h3 id="receipt-network">Network</h3><dl><CopyFact label="Chain ID" value={facts.network.chainId} generationToken={generationToken} commit={commit} /><CopyFact label="Manifest hash" value={facts.network.deploymentManifestHash} generationToken={generationToken} commit={commit} /><div className="review-fact"><dt>Profile</dt><dd>{doorway.network.label} · non-production network · no real value</dd></div><div className="review-fact"><dt>Manifest verification</dt><dd>{doorway.network.manifestVerification}</dd></div></dl></section>
    <section aria-labelledby="receipt-contract"><h3 id="receipt-contract">Contract</h3><dl><div className="review-fact"><dt>Domain</dt><dd>{facts.domain}</dd></div><CopyFact label="Contract address" value={facts.destination} compact generationToken={generationToken} commit={commit} /><div className="review-fact"><dt>Entrypoint</dt><dd>{facts.entrypoint}</dd></div><div className="review-fact"><dt>Amount</dt><dd>{facts.attachedMutez} mutez attached</dd></div></dl></section>
    <section aria-labelledby="receipt-payload"><h3 id="receipt-payload">Public payload</h3><dl><div className="review-fact"><dt>Schema</dt><dd>{facts.payloadSchemaVersion}</dd></div><CopyFact label="Opaque commitment" value={facts.serviceCommitment} generationToken={generationToken} commit={commit} /><div className="review-fact"><dt>Content version</dt><dd>{facts.contentVersion}</dd></div><CopyFact label="Nonce" value={facts.nonce} generationToken={generationToken} commit={commit} /><div className="review-fact"><dt>Issued</dt><dd>{facts.issuedAt}</dd></div><div className="review-fact"><dt>Expires</dt><dd>{facts.expiry}</dd></div><div className="review-fact"><dt>Issuer key</dt><dd>{facts.issuerKeyId}</dd></div><div className="review-fact"><dt>Issuer policy</dt><dd>{facts.issuerPolicyVersion}</dd></div><CopyFact label="Payload hash" value={facts.payloadHash} generationToken={generationToken} commit={commit} /></dl>
      <details><summary>Exact payload bytes</summary><CopyFact label="Exact payload bytes" value={facts.packedPayloadHex} generationToken={generationToken} commit={commit} /></details></section>
    <section aria-labelledby="receipt-fee"><h3 id="receipt-fee">Network fee</h3><p>{FEE}</p></section>
    <section aria-labelledby="receipt-validity"><h3 id="receipt-validity">Validity and finality</h3><dl><div className="review-fact"><dt>Created</dt><dd>{projection.intent.createdAt}</dd></div><div className="review-fact"><dt>Expires</dt><dd>{projection.intent.expiresAt}</dd></div><div className="review-fact"><dt>Confirmation threshold</dt><dd>{projection.policy.confirmationThreshold}</dd></div><div className="review-fact"><dt>Finality policy</dt><dd>{projection.policy.finalityPolicyRef}</dd></div></dl></section>
    <section aria-labelledby="receipt-meaning"><h3 id="receipt-meaning">If later recorded, what this would prove</h3><p>{WOULD_PROVE}</p><h4>What it would not prove</h4><p>{WOULD_NOT_PROVE}</p><h4>Public privacy boundary</h4><p>{PRIVACY}</p></section>
  </div>;
}

export function ReceiptReviewDoorway() {
  const [open, setOpen] = useState(false); const [phase, setPhase] = useState<ReviewPhase>("closed");
  const [copy, setCopy] = useState<WalletReviewCopy>(WALLET_REVIEW_COPY["wallet.access.required"]);
  const [actionCopy, setActionCopy] = useState<WalletReviewCopy>(WALLET_REVIEW_COPY["wallet.access.required"]);
  const [projection, setProjection] = useState<BrowserSafeReceiptReviewProjectionV1 | null>(null);
  const [doorway, setDoorway] = useState<ReceiptReviewDoorwayView | null>(null);
  const [wallet, setWallet] = useState<WalletRuntimeSyncView | null>(null); const [retiredWallet, setRetiredWallet] = useState<WalletAccessView | null>(null);
  const [runtimeStale, setRuntimeStale] = useState(false); const [preflight, setPreflight] = useState<ReceiptReviewPreflightResult | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null); const invokerRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null); const statusRef = useRef<HTMLHeadingElement>(null);
  const generation = useRef(0); const openRef = useRef(false); const portRef = useRef<WalletRuntimePort | null>(null);
  const projectionRef = useRef<BrowserSafeReceiptReviewProjectionV1 | null>(null); const walletRef = useRef<WalletRuntimeSyncView | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null); const abortRef = useRef<AbortController | null>(null);

  const active = useCallback((token: number, expectedProjection?: BrowserSafeReceiptReviewProjectionV1, expectedWallet?: WalletRuntimeSyncView) =>
    openRef.current && generation.current === token && (!expectedProjection || projectionRef.current === expectedProjection)
      && (!expectedWallet || walletRef.current === expectedWallet), []);
  const controller = useCallback(() => { abortRef.current?.abort(); const next = new AbortController(); abortRef.current = next; return next; }, []);
  const focusStatus = useCallback((token: number) => window.requestAnimationFrame(() => { if (active(token)) statusRef.current?.focus(); }), [active]);
  const commitCopy = useCallback((token: number, next: WalletReviewCopy, focus = false, nextAction = next) => {
    if (!active(token)) return false; setCopy(next); setActionCopy(nextAction); setAnnouncement(next.tone === "blocking" ? "" : `${next.title}. ${next.message}`);
    if (focus) focusStatus(token); return true;
  }, [active, focusStatus]);
  const commitClipboard = useCallback((token: number, nextAnnouncement?: string) => {
    if (!active(token)) return false; if (nextAnnouncement !== undefined) setAnnouncement(nextAnnouncement); return true;
  }, [active]);
  const retireAsync = useCallback(() => { generation.current += 1; abortRef.current?.abort(); abortRef.current = null;
    unsubscribeRef.current?.(); unsubscribeRef.current = null; portRef.current = null; }, []);
  const close = useCallback(() => { openRef.current = false; retireAsync(); setOpen(false); setPhase("closed"); setRuntimeStale(false);
    dialogRef.current?.close(); window.requestAnimationFrame(() => invokerRef.current?.focus()); }, [retireAsync]);

  const restore = useCallback(async (token: number, focusResult = false) => {
    setPhase("loading"); commitCopy(token, WALLET_REVIEW_COPY["receipt.review.loading"]);
    try {
      if (!active(token)) return; const response = await postJson(RECEIPT_REVIEW_RESTORE_PATH, "{}", controller().signal);
      if (!active(token) || !response.ok) throw new TypeError("restore"); const raw = await response.json();
      if (!active(token)) return; const body = restoreBody(raw); setDoorway(body.doorway); setRetiredWallet(body.walletAccess);
      if (body.projection === null) { setPhase("access"); commitCopy(token, body.accessPresentation, focusResult); return; }
      const restored = parseBrowserSafeReceiptReviewProjection(body.projection); if (!active(token)) return;
      const restoredCopy = body.accessPresentation.ref === "wallet.access.account-proof-unavailable"
        ? body.accessPresentation : WALLET_REVIEW_COPY["receipt.review.restored"];
      projectionRef.current = restored; setProjection(restored); setPhase("review"); commitCopy(token, restoredCopy, focusResult, body.accessPresentation);
    } catch { if (active(token)) { setPhase("unavailable"); commitCopy(token, WALLET_REVIEW_COPY["wallet.access.unavailable"], true); } }
  }, [active, commitCopy, controller]);

  const openReview = useCallback(() => { retireAsync(); const token = generation.current; openRef.current = true; setOpen(true);
    projectionRef.current = null; walletRef.current = null; setProjection(null); setDoorway(null); setWallet(null); setRetiredWallet(null);
    setActionCopy(WALLET_REVIEW_COPY["wallet.access.required"]); setRuntimeStale(false); setPreflight(null); setAnnouncement("");
    window.requestAnimationFrame(() => { if (!active(token)) return; dialogRef.current?.showModal(); headingRef.current?.focus(); }); void restore(token);
  }, [active, restore, retireAsync]);
  useEffect(() => () => { openRef.current = false; retireAsync(); }, [retireAsync]);

  const connect = useCallback(async () => {
    const priorWallet = wallet && durableWalletAccess(wallet) ? wallet : retiredWallet;
    retireAsync(); const token = generation.current; const runtimeGeneration = token; walletRef.current = null; setWallet(null);
    setPhase("requesting"); setPreflight(null); setRuntimeStale(false);
    commitCopy(token, WALLET_REVIEW_COPY["wallet.access.requesting"]);
    try {
      if (priorWallet) {
        if (!active(token)) return; const disconnected = await postJson(WALLET_RUNTIME_DISCONNECT_PATH, JSON.stringify({ idempotencyKey: requestId(),
          walletLinkRef: priorWallet.walletLinkRef, runtimeGeneration: priorWallet.runtimeGeneration, sessionRevision: priorWallet.sessionRevision }), controller().signal);
        if (!active(token) || !disconnected.ok) throw new TypeError("disconnect"); setRetiredWallet(null);
      }
      if (!active(token)) return; const module = await import("./wallet-runtime-browser");
      await developmentBarrier(1); if (!active(token)) return;
      const port = module.createBrowserWalletRuntimePort(); if (!active(token)) return;
      const permission = await port.requestPermission(); if (!active(token)) return;
      if (permission.status !== "PERMISSIONED") { setPhase(permission.status === "UNAVAILABLE" ? "unavailable" : "access"); commitCopy(token, permission.presentation, true); return; }
      const runtime = permission.runtime; if (!active(token)) return;
      if (doorway && runtime.chainId !== doorway.network.chainId) { setPhase("access"); commitCopy(token, WALLET_REVIEW_COPY["wallet.access.wrong-network"], true); return; }
      const response = await postJson(WALLET_RUNTIME_SYNC_PATH, JSON.stringify({ idempotencyKey: requestId(), runtimeGeneration,
        sessionRevision: 0, runtime }), controller().signal);
      if (!active(token) || !response.ok) throw new TypeError("sync"); const accessRaw = await response.json();
      if (!active(token)) return; const access = parseWalletRuntimeSyncView(accessRaw); walletRef.current = access; setWallet(access); commitCopy(token, access.presentation);
      if (!durableWalletAccess(access) || !access.credentialMatch) { setPhase("unavailable"); focusStatus(token); return; }
      if (!active(token, undefined, access)) return; const prepared = await postJson(RECEIPT_REVIEW_PREPARE_PATH, JSON.stringify({ idempotencyKey: requestId(),
        walletLinkRef: access.walletLinkRef, runtimeGeneration: access.runtimeGeneration, sessionRevision: access.sessionRevision }), controller().signal);
      if (!active(token, undefined, access) || !prepared.ok) throw new TypeError("prepare"); const preparedRaw = await prepared.json();
      if (!active(token, undefined, access)) return; const nextProjection = preparedBody(preparedRaw); projectionRef.current = nextProjection;
      setProjection(nextProjection); setPhase("review"); setRuntimeStale(false); if (!active(token, nextProjection, access)) return;
      portRef.current = port; unsubscribeRef.current = port.subscribeNormalizedRuntimeChanges((change) => {
        if (!active(token, nextProjection, access) || portRef.current !== port) return;
        const nextCopy = change.status === "RUNTIME" ? runtimeDriftPresentation(runtime, change.runtime) : change.presentation;
        if (!nextCopy) return; retireAsync(); const driftToken = generation.current; setRuntimeStale(true); setPreflight(null); setPhase("review");
        commitCopy(driftToken, nextCopy, true);
      });
      if (!active(token, nextProjection, access)) { unsubscribeRef.current?.(); unsubscribeRef.current = null; portRef.current = null; return; }
      commitCopy(token, WALLET_REVIEW_COPY["wallet.access.connected"], true);
    } catch { if (active(token)) { setPhase("unavailable"); commitCopy(token, WALLET_REVIEW_COPY["wallet.access.unavailable"], true); } }
  }, [active, commitCopy, controller, doorway, focusStatus, retiredWallet, retireAsync, wallet]);

  const check = useCallback(async () => {
    if (!projection || !wallet || !durableWalletAccess(wallet) || runtimeStale) return; abortRef.current?.abort(); const token = generation.current;
    projectionRef.current = projection; walletRef.current = wallet; setPhase("preflight"); commitCopy(token, WALLET_REVIEW_COPY["receipt.preflight.checking"]);
    try {
      const port = portRef.current; if (!port || !active(token, projection, wallet)) return;
      const currentRuntime = await port.readNormalizedRuntime(); if (!active(token, projection, wallet)) return;
      const drift = runtimeDriftPresentation({ providerId: wallet.providerId, chainId: wallet.chainId, account: wallet.account,
        permissionScopes: wallet.permissionScopes }, currentRuntime);
      if (drift) { setRuntimeStale(true); setPhase("review"); commitCopy(token, drift, true); return; }
      const reviewDigest = await sha256(projection); if (!active(token, projection, wallet)) return;
      const response = await postJson(RECEIPT_REVIEW_PREFLIGHT_PATH, JSON.stringify({ idempotencyKey: requestId(), walletLinkRef: wallet.walletLinkRef,
        runtimeGeneration: wallet.runtimeGeneration, sessionRevision: wallet.sessionRevision, publicIntentRef: projection.intent.intentRef,
        expectedProjectionRevision: projection.projectionRevision, reviewDigest }), controller().signal);
      if (!active(token, projection, wallet) || !response.ok) throw new TypeError("preflight"); const raw = await response.json();
      if (!active(token, projection, wallet)) return; const next = parseReceiptReviewPreflightResult(raw); setPreflight(next); setPhase("review");
      commitCopy(token, next.presentation, true);
    } catch { if (active(token, projection, wallet)) { setPhase("review"); commitCopy(token, WALLET_REVIEW_COPY["receipt.preflight.mismatch"], true); } }
  }, [active, commitCopy, controller, projection, runtimeStale, wallet]);

  const restoreAcknowledged = useCallback(() => {
    retireAsync(); const token = generation.current; projectionRef.current = null; walletRef.current = null;
    setProjection(null); setWallet(null); setRetiredWallet(null); setRuntimeStale(false); setPreflight(null); void restore(token, true);
  }, [restore, retireAsync]);
  const recoveryRef = actionCopy.recoveryAction?.ref;
  const recover = (() => {
    switch (recoveryRef) {
      case "wallet.access.connect": case "wallet.access.retry": case "wallet.access.reconnect": case "wallet.access.retry-network": return connect;
      case "wallet.access.close": case "review.close": return close;
      case "receipt.preflight.retry": return check;
      case "receipt.review.restore": case "receipt.review.refresh": return restoreAcknowledged;
      default: return null;
    }
  })();
  return <section className="keepsake-doorway" aria-label="Optional service keepsake">
    <strong>Optional service keepsake</strong><span>Non-transferable · no financial value</span>
    <button ref={invokerRef} type="button" className="text-action review-invoker" onClick={openReview}>Review optional keepsake</button>
    {open ? <dialog ref={dialogRef} className="receipt-review-dialog" aria-labelledby="receipt-review-title" onCancel={(event) => { event.preventDefault(); close(); }}
      onKeyDown={(event) => { if (event.key !== "Tab") return; const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),summary,[href]")];
        const first = controls[0]; const last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }}>
      <div className="review-dialog-frame"><header><div><p>Optional · non-transferable · no financial value</p><h2 ref={headingRef} tabIndex={-1} id="receipt-review-title">Review optional service keepsake</h2></div><button type="button" className="text-action" onClick={close}>Close review</button></header>
        {doorway ? <p className="review-effect"><strong>{doorway.effect}</strong></p> : null}
        {projection?.intent.state === "REVIEWED" ? <p className="nothing-sent"><strong>Nothing has been sent.</strong> {RECEIPT_REVIEW_STATE_MEANINGS.REVIEWED}</p> : null}
        <div aria-busy={phase === "loading" || phase === "requesting" || phase === "preflight" ? "true" : undefined}><Status copy={copy} headingRef={statusRef} /></div>
        <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
        {!projection ? <section className="access-stage" aria-labelledby="wallet-access-title"><h3 id="wallet-access-title">Wallet account required</h3>{doorway ? <><p>Required network: <strong>{doorway.network.label} · non-production · no real value</strong></p><p>{doorway.access}</p></> : null}
          {doorway && phase !== "loading" && phase !== "requesting" && recover && actionCopy.recoveryAction ? <div className="review-actions"><button className="primary-action" type="button" onClick={() => void recover()}>{actionCopy.recoveryAction.label}</button><button type="button" className="text-action" onClick={close}>Not now</button></div> : <button type="button" className="text-action" onClick={close}>Not now</button>}
        </section> : <>
          {doorway ? <ReceiptFacts projection={projection} doorway={doorway} generationToken={generation.current} commit={commitClipboard} /> : null}
          <section aria-labelledby="current-wallet"><h3 id="current-wallet">Current wallet</h3>{wallet ? <dl><div className="review-fact"><dt>Provider</dt><dd>{wallet.providerId}</dd></div><CopyFact label="Wallet account" value={wallet.account} compact generationToken={generation.current} commit={commitClipboard} /><CopyFact label="Wallet chain ID" value={wallet.chainId} generationToken={generation.current} commit={commitClipboard} /><div className="review-fact"><dt>Permission</dt><dd>Account access</dd></div><div className="review-fact"><dt>Credential match</dt><dd>{wallet.credentialMatch ? "Exact active credential match" : "Not verified"}</dd></div></dl> : <p>Wallet disconnected. The receipt details remain read-only.</p>}</section>
          <section aria-labelledby="review-readiness"><h3 id="review-readiness">Review readiness</h3><p>{preflight?.status === "REVIEW_READY" ? "Exact current facts match." : preflight?.presentation.message ?? "Not checked."}</p>{preflight?.status === "NOT_READY" && preflight.presentation.reasonRef ? <p><strong>Safe reason:</strong> <span className="selectable-fact">{preflight.presentation.reasonRef}</span></p> : null}</section>
          <div className="review-actions">{(phase === "requesting" || phase === "preflight") && recover && actionCopy.recoveryAction ? <button type="button" className="text-action" onClick={() => void recover()}>{actionCopy.recoveryAction.label}</button> : preflight?.status === "NOT_READY" && recover && preflight.presentation.recoveryAction ? <button type="button" className="text-action" onClick={() => void recover()}>{preflight.presentation.recoveryAction.label}</button> : wallet?.credentialMatch && !runtimeStale ? <button type="button" className="primary-action" onClick={() => void check()}>{preflight?.status === "REVIEW_READY" ? "Check again" : "Check review readiness"}</button> : recover && actionCopy.recoveryAction ? <button type="button" className="text-action" onClick={() => void recover()}>{actionCopy.recoveryAction.label}</button> : null}<button type="button" className="text-action" onClick={close}>Close review</button></div>
          {wallet?.credentialMatch && !runtimeStale ? <p className="check-helper">Checks only. No signature or operation will be requested.</p> : null}
        </>}
      </div>
    </dialog> : null}
  </section>;
}
