"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseBrowserSafeReceiptReviewProjection, RECEIPT_REVIEW_STATE_MEANINGS,
  type BrowserSafeReceiptReviewProjectionV1 } from "@samurai-sushi/receipt-lifecycle";
import { parseReceiptReviewDoorway, parseReceiptReviewPreflightResult, parseWalletAccessView, WALLET_REVIEW_COPY,
  type NormalizedWalletRuntime, type ReceiptReviewDoorwayView, type ReceiptReviewPreflightResult, type WalletAccessView,
  type WalletRuntimePort,
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

function shortened(value: string): string { return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value; }
function sameRuntime(runtime: NormalizedWalletRuntime, wallet: WalletAccessView): boolean {
  return runtime.providerId === wallet.providerId && runtime.chainId === wallet.chainId && runtime.account === wallet.account
    && runtime.permissionScopes.length === 1 && runtime.permissionScopes[0] === "account";
}

function restoreBody(value: unknown): Readonly<{ doorway: ReceiptReviewDoorwayView; projection: unknown | null; walletAccess: WalletAccessView | null }> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError("Review restore is unavailable.");
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Object.getOwnPropertyNames(value).sort();
  if (keys.join(",") !== "doorway,projection,schemaVersion,walletAccess" || keys.some((key) => !descriptors[key]?.enumerable || !("value" in descriptors[key]!))) {
    throw new TypeError("Review restore is unavailable.");
  }
  const row = value as { readonly schemaVersion: unknown; readonly doorway: unknown; readonly projection: unknown; readonly walletAccess: unknown };
  if (row.schemaVersion !== 1 || row.projection === undefined || row.walletAccess === undefined) throw new TypeError("Review restore is unavailable.");
  return Object.freeze({ doorway: parseReceiptReviewDoorway(row.doorway), projection: row.projection,
    walletAccess: row.walletAccess === null ? null : parseWalletAccessView(row.walletAccess) });
}

function CopyFact({ label, value, compact = false }: Readonly<{ label: string; value: string; compact?: boolean }>) {
  const [copied, setCopied] = useState(false);
  return <div className="review-fact"><dt>{label}</dt><dd><span className="selectable-fact" title={compact ? value : undefined}>{compact ? <><span aria-hidden="true">{shortened(value)}</span><span className="sr-only">{value}</span></> : value}</span>
    <button type="button" className="copy-action" aria-label={`Copy full ${label.toLowerCase()}`} onClick={() => {
      void navigator.clipboard.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1_500); }).catch(() => undefined);
    }}>{copied ? "Copied" : "Copy"}</button></dd></div>;
}

function Status({ copy, alert = false, headingRef }: Readonly<{ copy: WalletReviewCopy; alert?: boolean; headingRef: React.RefObject<HTMLHeadingElement | null> }>) {
  return <section className={`review-status is-${copy.tone}`} role={alert ? "alert" : undefined} aria-live={alert ? undefined : "polite"} aria-atomic="true">
    <h3 ref={headingRef} tabIndex={-1}>{copy.title}</h3><p>{copy.message}</p>
  </section>;
}

function ReceiptFacts({ projection }: Readonly<{ projection: BrowserSafeReceiptReviewProjectionV1 }>) {
  const facts = projection.reviewFacts;
  return <div className="receipt-facts">
    <section aria-labelledby="receipt-account"><h3 id="receipt-account">Receipt account</h3><dl><CopyFact label="Account" value={facts.owner} compact /><div className="review-fact"><dt>Equality</dt><dd>Owner and source match exactly</dd></div></dl></section>
    <section aria-labelledby="receipt-network"><h3 id="receipt-network">Network</h3><dl><CopyFact label="Chain ID" value={facts.network.chainId} /><CopyFact label="Manifest hash" value={facts.network.deploymentManifestHash} /><div className="review-fact"><dt>Profile</dt><dd>{facts.network.profile} · non-production network · no real value</dd></div></dl></section>
    <section aria-labelledby="receipt-contract"><h3 id="receipt-contract">Contract</h3><dl><div className="review-fact"><dt>Domain</dt><dd>{facts.domain}</dd></div><CopyFact label="Contract address" value={facts.destination} compact /><div className="review-fact"><dt>Entrypoint</dt><dd>{facts.entrypoint}</dd></div><div className="review-fact"><dt>Amount</dt><dd>{facts.attachedMutez} mutez attached</dd></div></dl></section>
    <section aria-labelledby="receipt-payload"><h3 id="receipt-payload">Public payload</h3><dl><div className="review-fact"><dt>Schema</dt><dd>{facts.payloadSchemaVersion}</dd></div><CopyFact label="Opaque commitment" value={facts.serviceCommitment} /><div className="review-fact"><dt>Content version</dt><dd>{facts.contentVersion}</dd></div><CopyFact label="Nonce" value={facts.nonce} /><div className="review-fact"><dt>Issued</dt><dd>{facts.issuedAt}</dd></div><div className="review-fact"><dt>Expires</dt><dd>{facts.expiry}</dd></div><div className="review-fact"><dt>Issuer key</dt><dd>{facts.issuerKeyId}</dd></div><div className="review-fact"><dt>Issuer policy</dt><dd>{facts.issuerPolicyVersion}</dd></div><CopyFact label="Payload hash" value={facts.payloadHash} /></dl>
      <details><summary>Exact payload bytes</summary><CopyFact label="Exact payload bytes" value={facts.packedPayloadHex} /></details></section>
    <section aria-labelledby="receipt-fee"><h3 id="receipt-fee">Network fee</h3><p>{FEE}</p></section>
    <section aria-labelledby="receipt-validity"><h3 id="receipt-validity">Validity and finality</h3><dl><div className="review-fact"><dt>Created</dt><dd>{projection.intent.createdAt}</dd></div><div className="review-fact"><dt>Expires</dt><dd>{projection.intent.expiresAt}</dd></div><div className="review-fact"><dt>Confirmation threshold</dt><dd>{projection.policy.confirmationThreshold}</dd></div><div className="review-fact"><dt>Finality policy</dt><dd>{projection.policy.finalityPolicyRef}</dd></div></dl></section>
    <section aria-labelledby="receipt-meaning"><h3 id="receipt-meaning">If later recorded, what this would prove</h3><p>{WOULD_PROVE}</p><h4>What it would not prove</h4><p>{WOULD_NOT_PROVE}</p><h4>Public privacy boundary</h4><p>{PRIVACY}</p></section>
  </div>;
}

export function ReceiptReviewDoorway() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<ReviewPhase>("closed");
  const [copy, setCopy] = useState<WalletReviewCopy>(WALLET_REVIEW_COPY["wallet.access.required"]);
  const [projection, setProjection] = useState<BrowserSafeReceiptReviewProjectionV1 | null>(null);
  const [doorway, setDoorway] = useState<ReceiptReviewDoorwayView | null>(null);
  const [wallet, setWallet] = useState<WalletAccessView | null>(null);
  const [retiredWallet, setRetiredWallet] = useState<WalletAccessView | null>(null);
  const [runtimeStale, setRuntimeStale] = useState(false);
  const [preflight, setPreflight] = useState<ReceiptReviewPreflightResult | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const invokerRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const statusRef = useRef<HTMLHeadingElement>(null);
  const generation = useRef(0);
  const portRef = useRef<WalletRuntimePort | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const close = useCallback(() => {
    generation.current += 1; unsubscribeRef.current?.(); unsubscribeRef.current = null; portRef.current = null;
    setOpen(false); setPhase("closed"); setRuntimeStale(false);
    dialogRef.current?.close(); window.requestAnimationFrame(() => invokerRef.current?.focus());
  }, []);

  const restore = useCallback(async (token: number) => {
    setPhase("loading"); setCopy(WALLET_REVIEW_COPY["receipt.review.loading"]);
    try {
      const response = await postJson(RECEIPT_REVIEW_RESTORE_PATH, "{}");
      if (token !== generation.current) return;
      if (!response.ok) throw new TypeError("restore");
      const body = restoreBody(await response.json()); setDoorway(body.doorway); setRetiredWallet(body.walletAccess);
      if (body.projection === null) { setPhase("access"); setCopy(WALLET_REVIEW_COPY["wallet.access.required"]); return; }
      const restored = parseBrowserSafeReceiptReviewProjection(body.projection);
      setProjection(restored); setPhase("review"); setCopy(WALLET_REVIEW_COPY["receipt.review.restored"]);
    } catch { if (token === generation.current) { setPhase("unavailable"); setCopy(WALLET_REVIEW_COPY["wallet.access.unavailable"]); } }
  }, []);

  const openReview = useCallback(() => {
    const token = ++generation.current; unsubscribeRef.current?.(); unsubscribeRef.current = null; portRef.current = null;
    setOpen(true); setProjection(null); setDoorway(null); setWallet(null); setRetiredWallet(null); setRuntimeStale(false); setPreflight(null);
    window.requestAnimationFrame(() => { dialogRef.current?.showModal(); headingRef.current?.focus(); });
    void restore(token);
  }, [restore]);

  useEffect(() => () => { generation.current += 1; unsubscribeRef.current?.(); }, []);

  const connect = useCallback(async () => {
    const token = ++generation.current; const runtimeGeneration = token;
    setPhase("requesting"); setCopy(WALLET_REVIEW_COPY["wallet.access.requesting"]);
    try {
      const priorWallet = wallet ?? retiredWallet;
      if (priorWallet) {
        const disconnected = await postJson(WALLET_RUNTIME_DISCONNECT_PATH, JSON.stringify({ idempotencyKey: requestId(),
          walletLinkRef: priorWallet.walletLinkRef, runtimeGeneration: priorWallet.runtimeGeneration, sessionRevision: priorWallet.sessionRevision }));
        if (!disconnected.ok || token !== generation.current) throw new TypeError("disconnect");
        setRetiredWallet(null);
      }
      const { createBrowserWalletRuntimePort } = await import("./wallet-runtime-browser");
      const port = createBrowserWalletRuntimePort();
      const runtime = await port.requestPermission();
      if (token !== generation.current || !open) return;
      const response = await postJson(WALLET_RUNTIME_SYNC_PATH, JSON.stringify({ idempotencyKey: requestId(), runtimeGeneration, sessionRevision: 0, runtime }));
      if (!response.ok) throw new TypeError("sync");
      const access = parseWalletAccessView(await response.json());
      if (token !== generation.current) return;
      setWallet(access); setCopy(access.presentation);
      if (!access.credentialMatch) { setPhase("unavailable"); window.requestAnimationFrame(() => statusRef.current?.focus()); return; }
      const prepared = await postJson(RECEIPT_REVIEW_PREPARE_PATH, JSON.stringify({ idempotencyKey: requestId(), walletLinkRef: access.walletLinkRef,
        runtimeGeneration: access.runtimeGeneration, sessionRevision: access.sessionRevision }));
      if (!prepared.ok || token !== generation.current) throw new TypeError("prepare");
      const body = await prepared.json() as { projection?: unknown };
      setProjection(parseBrowserSafeReceiptReviewProjection(body.projection)); setPhase("review"); setRuntimeStale(false);
      unsubscribeRef.current?.(); portRef.current = port;
      unsubscribeRef.current = port.subscribeNormalizedRuntimeChanges((nextRuntime) => {
        if (portRef.current !== port || sameRuntime(nextRuntime, access)) return;
        generation.current += 1; setRuntimeStale(true); setPreflight(null); setCopy(WALLET_REVIEW_COPY["receipt.preflight.mismatch"]);
        window.requestAnimationFrame(() => statusRef.current?.focus());
      });
      setCopy(WALLET_REVIEW_COPY["wallet.access.connected"]); window.requestAnimationFrame(() => statusRef.current?.focus());
    } catch { if (token === generation.current) { setPhase("unavailable"); setCopy(WALLET_REVIEW_COPY["wallet.access.unavailable"]); window.requestAnimationFrame(() => statusRef.current?.focus()); } }
  }, [open, retiredWallet, wallet]);

  const check = useCallback(async () => {
    if (!projection || !wallet || runtimeStale) return;
    const token = ++generation.current; setPhase("preflight"); setCopy(WALLET_REVIEW_COPY["receipt.preflight.checking"]);
    try {
      const currentRuntime = await portRef.current?.readNormalizedRuntime();
      if (!currentRuntime || token !== generation.current || !sameRuntime(currentRuntime, wallet)) {
        if (token === generation.current) { setRuntimeStale(true); setPhase("review"); setCopy(WALLET_REVIEW_COPY["receipt.preflight.mismatch"]);
          window.requestAnimationFrame(() => statusRef.current?.focus()); }
        return;
      }
      const reviewDigest = await sha256(projection);
      const response = await postJson(RECEIPT_REVIEW_PREFLIGHT_PATH, JSON.stringify({ idempotencyKey: requestId(), walletLinkRef: wallet.walletLinkRef,
        runtimeGeneration: wallet.runtimeGeneration, sessionRevision: wallet.sessionRevision, publicIntentRef: projection.intent.intentRef,
        expectedProjectionRevision: projection.projectionRevision, reviewDigest }));
      if (!response.ok || token !== generation.current) throw new TypeError("preflight");
      const next = parseReceiptReviewPreflightResult(await response.json()); setPreflight(next); setPhase("review");
      setCopy(next.status === "REVIEW_READY" ? WALLET_REVIEW_COPY["receipt.preflight.ready"] : next.reason === "INTENT_EXPIRED"
        ? WALLET_REVIEW_COPY["receipt.review.expired"] : WALLET_REVIEW_COPY["receipt.preflight.mismatch"]);
      window.requestAnimationFrame(() => statusRef.current?.focus());
    } catch { if (token === generation.current) { setPhase("review"); setCopy(WALLET_REVIEW_COPY["receipt.preflight.mismatch"]); window.requestAnimationFrame(() => statusRef.current?.focus()); } }
  }, [projection, runtimeStale, wallet]);

  return <section className="keepsake-doorway" aria-label="Optional service keepsake">
    <strong>Optional service keepsake</strong><span>Non-transferable · no financial value</span>
    <button ref={invokerRef} type="button" className="text-action review-invoker" onClick={openReview}>Review optional keepsake</button>
    {open ? <dialog ref={dialogRef} className="receipt-review-dialog" aria-labelledby="receipt-review-title" onCancel={(event) => { event.preventDefault(); close(); }}
      onKeyDown={(event) => { if (event.key !== "Tab") return; const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),summary,[href]")];
        const first = controls[0]; const last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }}>
      <div className="review-dialog-frame">
        <header><div><p>Optional · non-transferable · no financial value</p><h2 ref={headingRef} tabIndex={-1} id="receipt-review-title">Review optional service keepsake</h2></div><button type="button" className="text-action" onClick={close}>Close review</button></header>
        {doorway ? <p className="review-effect"><strong>{doorway.effect}</strong></p> : null}
        {projection?.intent.state === "REVIEWED" ? <p className="nothing-sent"><strong>Nothing has been sent.</strong> {RECEIPT_REVIEW_STATE_MEANINGS.REVIEWED}</p> : null}
        <div aria-busy={phase === "loading" || phase === "requesting" || phase === "preflight" ? "true" : undefined}><Status copy={copy} alert={copy.tone === "blocking"} headingRef={statusRef} /></div>
        {!projection ? <section className="access-stage" aria-labelledby="wallet-access-title"><h3 id="wallet-access-title">Wallet account required</h3>{doorway ? <><p>Required network: <strong>{doorway.network.label} · non-production · no real value</strong></p><p>{doorway.access}</p></> : null}
          {doorway && phase !== "loading" && phase !== "requesting" ? <div className="review-actions"><button className="primary-action" type="button" onClick={() => void connect()}>{doorway.actionLabel}</button><button type="button" className="text-action" onClick={close}>Not now</button></div> : <button type="button" className="text-action" onClick={close}>Not now</button>}
        </section> : <>
          <ReceiptFacts projection={projection} />
          <section aria-labelledby="current-wallet"><h3 id="current-wallet">Current wallet</h3>{wallet ? <dl><div className="review-fact"><dt>Provider</dt><dd>{wallet.providerId}</dd></div><CopyFact label="Wallet account" value={wallet.account} compact /><CopyFact label="Wallet chain ID" value={wallet.chainId} /><div className="review-fact"><dt>Permission</dt><dd>Account access</dd></div><div className="review-fact"><dt>Credential match</dt><dd>{wallet.credentialMatch ? "Exact active credential match" : "Not verified"}</dd></div></dl> : <p>Wallet disconnected. The receipt details remain read-only.</p>}</section>
          <section aria-labelledby="review-readiness"><h3 id="review-readiness">Review readiness</h3><p>{preflight?.status === "NOT_READY" ? copy.message : preflight?.status === "REVIEW_READY" ? "Exact current facts match." : "Not checked."}</p></section>
          <div className="review-actions">{wallet?.credentialMatch && !runtimeStale ? <button type="button" className="primary-action" disabled={phase === "preflight"} onClick={() => void check()}>{phase === "preflight" ? "Checking…" : preflight?.status === "REVIEW_READY" ? "Check again" : "Check review readiness"}</button> : <button type="button" className="text-action" onClick={() => void connect()}>Reconnect matching wallet</button>}<button type="button" className="text-action" onClick={close}>Close review</button></div>
          {wallet?.credentialMatch && !runtimeStale ? <p className="check-helper">Checks only. No signature or operation will be requested.</p> : null}
        </>}
      </div>
    </dialog> : null}
  </section>;
}
