"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  COOKIE_RESET_PATH,
  GUEST_ISSUE_PATH,
  SERVICE_COMMAND_PATH,
  SERVICE_QUERY_PATH,
  createIntentEnvelope,
  decodeServiceResponse,
  isServiceAuthorityRejection,
  isServiceCredentialRefreshed,
  postJson,
  type IntentEnvelope,
  type ServiceView,
  type ViewAsset,
  type ViewChoice,
  type ViewLedgerRow,
} from "./service-browser";
import { ReceiptReviewDoorway } from "./receipt-review";

type TransportPhase = "loading" | "ready" | "sending" | "outcome-unknown" | "requerying" | "unavailable" | "authority";
type FocusTarget = "preserve" | "task" | "choice" | "feedback";
interface PendingFocusIntent {
  readonly target: Exclude<FocusTarget, "preserve">;
  readonly requestGeneration: number;
  readonly identity: ServiceView["identity"];
  readonly serviceGeneration: number;
  readonly revision: number;
}

function PixelAsset({ asset, className = "", scale = 2 }: Readonly<{ asset: ViewAsset; className?: string; scale?: number }>) {
  return (
    <svg className={`pixel-asset ${className}`} viewBox={`0 0 ${asset.width} ${asset.height}`} width={asset.width} height={asset.height}
      style={{ "--asset-width": `${asset.width}px`, "--asset-height": `${asset.height}px`, "--asset-scale": scale } as CSSProperties}
      role="img" aria-label={asset.nonColorIdentity}>
      <use href={asset.path} />
    </svg>
  );
}

function CounterScene({ view }: Readonly<{ view: ServiceView }>) {
  return <svg className="counter-scene-composition" viewBox="0 0 320 180" role="img" aria-label={`${view.scene.nonColorIdentity} Saved restoration layers: ${view.sceneLayers.length - 1}.`}>
    <use href={view.scene.path} x="0" y="0" width="320" height="180" />
    {view.sceneLayers.map((layer) => <use key={layer.asset.key} href={layer.asset.path} x={layer.x} y={layer.y} width={layer.asset.width} height={layer.asset.height} />)}
  </svg>;
}

function requestTimeout(): { readonly signal: AbortSignal; readonly clear: () => void } {
  const controller = new AbortController();
  const handle = window.setTimeout(() => controller.abort(), 8_000);
  return { signal: controller.signal, clear: () => window.clearTimeout(handle) };
}

export function CounterShell() {
  const [view, setView] = useState<ServiceView | null>(null);
  const [phase, setPhase] = useState<TransportPhase>("loading");
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState<IntentEnvelope | null>(null);
  const [announcement, setAnnouncement] = useState("Loading the last saved counter state.");
  const [abandonOpen, setAbandonOpen] = useState(false);
  const [ceremonyRow, setCeremonyRow] = useState<ViewLedgerRow | null>(null);
  const [showLedger, setShowLedger] = useState(false);
  const [miseOpen, setMiseOpen] = useState(true);
  const [pendingFocus, setPendingFocus] = useState<PendingFocusIntent | null>(null);
  const generation = useRef(0);
  const viewRef = useRef<ServiceView | null>(null);
  const envelopeRef = useRef<IntentEnvelope | null>(null);
  const taskRef = useRef<HTMLHeadingElement>(null);
  const choicesRef = useRef<HTMLFieldSetElement>(null);
  const feedbackRef = useRef<HTMLHeadingElement>(null);
  const abandonButtonRef = useRef<HTMLButtonElement>(null);
  const cancelAbandonRef = useRef<HTMLButtonElement>(null);
  const abandonDialogRef = useRef<HTMLDialogElement>(null);

  const beginRequest = useCallback(() => {
    const token = ++generation.current;
    setPendingFocus(null);
    return token;
  }, []);

  const publishView = useCallback((next: ServiceView, envelope: IntentEnvelope | null, note?: string, focus: FocusTarget = "preserve", requestGeneration = generation.current) => {
    const current = viewRef.current;
    if (current && next.revision < current.revision) return;
    viewRef.current = next;
    setView(next);
    setSelectedChoice(next.choices.length === 1 ? next.choices[0]!.id : null);
    setPhase("ready");
    if (envelope && next.disposition === "committed" && next.announceCeremony) {
      setAnnouncement(next.correctiveCue?.text ?? next.prompt.text);
    } else {
      setAnnouncement(note ?? next.correctiveCue?.text ?? `Saved service revision ${next.revision}.`);
    }
    if (focus !== "preserve") setPendingFocus({
      target: focus,
      requestGeneration,
      identity: next.identity,
      serviceGeneration: next.generation,
      revision: next.revision,
    });
  }, []);

  useLayoutEffect(() => {
    if (!pendingFocus) return;
    const matchesCommittedView = view && pendingFocus.requestGeneration === generation.current
      && pendingFocus.identity === view.identity && pendingFocus.serviceGeneration === view.generation
      && pendingFocus.revision === view.revision;
    const target = matchesCommittedView ? (pendingFocus.target === "choice"
      ? choicesRef.current?.querySelector<HTMLInputElement>("input:not(:disabled)") ?? null
      : pendingFocus.target === "feedback" ? feedbackRef.current : taskRef.current) : null;
    if (target) target.focus();
    setPendingFocus(null);
  }, [pendingFocus, view]);

  const clearEnvelope = useCallback(() => {
    envelopeRef.current = null;
    setInFlight(null);
  }, []);

  const reconcile: (envelope: IntentEnvelope, refreshAttempted?: boolean) => Promise<void> = useCallback(async (envelope: IntentEnvelope, refreshAttempted = false) => {
    const token = beginRequest();
    setPhase("requerying");
    const timeout = requestTimeout();
    try {
      const queried = await postJson(SERVICE_QUERY_PATH, "{}", timeout.signal);
      if (token !== generation.current || envelopeRef.current !== envelope) return;
      if (!queried.ok) {
        const refreshed = await isServiceCredentialRefreshed(queried.clone());
        const authority = !refreshed && await isServiceAuthorityRejection(queried);
        if (token !== generation.current || envelopeRef.current !== envelope) return;
        if (refreshed && !refreshAttempted) {
          setAnnouncement("Service access was refreshed for this guest. Requerying the saved service.");
          void reconcile(envelope, true);
        } else if (authority) {
          clearEnvelope();
          setPhase("authority");
          setAnnouncement("Service access needs recovery.");
        } else {
          setPhase("outcome-unknown");
          setAnnouncement("The command outcome is still unknown. Requery before retrying.");
        }
        return;
      }
      const canonical = decodeServiceResponse(await queried.json());
      if (canonical.revision < envelope.expectedRevision) throw new Error("Service revision moved backward.");
      if (token !== generation.current || envelopeRef.current !== envelope) return;
      publishView(canonical, null, "Canonical service state restored before exact retry.");
      setPhase("sending");
      const retry = await postJson(SERVICE_COMMAND_PATH, envelope.canonicalBody, timeout.signal);
      if (token !== generation.current || envelopeRef.current !== envelope) return;
      if (retry.status === 409) {
        clearEnvelope();
        publishView(canonical, null, "Another saved action superseded this intent. Choose again from the current service.");
        return;
      }
      if (!retry.ok) {
        const refreshed = await isServiceCredentialRefreshed(retry.clone());
        const authority = !refreshed && await isServiceAuthorityRejection(retry);
        if (token !== generation.current || envelopeRef.current !== envelope) return;
        if (refreshed && !refreshAttempted) {
          setPhase("requerying");
          setAnnouncement("Service access was refreshed for this guest. Requerying before exact retry.");
          void reconcile(envelope, true);
        } else if (authority) {
          clearEnvelope();
          setPhase("authority");
          setAnnouncement("Service access needs recovery.");
        } else {
          setPhase("outcome-unknown");
          setAnnouncement("The exact command is retained in memory; its outcome remains unknown.");
        }
        return;
      }
      const recovered = decodeServiceResponse(await retry.json());
      if (recovered.revision < canonical.revision) throw new Error("Delayed response cannot replace canonical state.");
      clearEnvelope();
      publishView(recovered, envelope, recovered.disposition === "replayed" ? "The saved response was recovered without repeating service ceremony." : undefined);
    } catch {
      if (token === generation.current && envelopeRef.current === envelope) {
        setPhase("outcome-unknown");
        setAnnouncement("The exact command is retained in memory. Requery before retrying.");
      }
    } finally {
      timeout.clear();
    }
  }, [beginRequest, clearEnvelope, publishView]);

  const query: (refreshAttempted?: boolean, focus?: FocusTarget) => Promise<void> = useCallback(async (refreshAttempted = false, focus = "preserve") => {
    const token = beginRequest();
    setPhase(viewRef.current ? "requerying" : "loading");
    const timeout = requestTimeout();
    try {
      const response = await postJson(SERVICE_QUERY_PATH, "{}", timeout.signal);
      if (token !== generation.current) return;
      if (!response.ok) {
        const refreshed = await isServiceCredentialRefreshed(response.clone());
        const authority = !refreshed && await isServiceAuthorityRejection(response);
        if (token !== generation.current) return;
        if (refreshed && !refreshAttempted) {
          setPhase("requerying");
          setAnnouncement("Service access was refreshed for this guest. Requerying the saved service.");
          void query(true, focus);
        } else {
          setPhase(authority ? "authority" : "unavailable");
          setAnnouncement(authority ? "Service access needs recovery." : "The service is temporarily unavailable.");
        }
        return;
      }
      publishView(decodeServiceResponse(await response.json()), null, undefined, focus, token);
    } catch {
      if (token === generation.current) {
        setPhase("unavailable");
        setAnnouncement("The service is temporarily unavailable. Your browser stored no gameplay state.");
      }
    } finally {
      timeout.clear();
    }
  }, [beginRequest, publishView]);

  useEffect(() => { void query(); }, [query]);

  useEffect(() => () => { generation.current += 1; }, []);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible" && !envelopeRef.current) void query(); };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [query]);

  useEffect(() => {
    const dialog = abandonDialogRef.current;
    if (abandonOpen && dialog && !dialog.open) {
      dialog.showModal();
      window.requestAnimationFrame(() => cancelAbandonRef.current?.focus());
    } else if (!abandonOpen && dialog?.open) dialog.close();
  }, [abandonOpen]);

  useEffect(() => {
    if (view?.choices.length) setMiseOpen(true);
  }, [view?.choices]);

  const execute = useCallback(async (choiceInput: string | ViewChoice) => {
    const current = viewRef.current;
    const choice = typeof choiceInput === "string" ? current?.choices.find((item) => item.id === choiceInput) : choiceInput;
    if (!current || !choice || envelopeRef.current) return;
    let envelope: IntentEnvelope;
    try { envelope = createIntentEnvelope(current, choice); } catch {
      setPhase("unavailable");
      setAnnouncement("Secure command creation is unavailable.");
      return;
    }
    envelopeRef.current = envelope;
    setInFlight(envelope);
    setPhase("sending");
    const token = beginRequest();
    const timeout = requestTimeout();
    try {
      const response = await postJson(SERVICE_COMMAND_PATH, envelope.canonicalBody, timeout.signal);
      if (token !== generation.current || envelopeRef.current !== envelope) return;
      if (!response.ok) {
        const refreshed = await isServiceCredentialRefreshed(response.clone());
        const authority = !refreshed && await isServiceAuthorityRejection(response);
        if (token !== generation.current || envelopeRef.current !== envelope) return;
        if (refreshed) {
          setPhase("requerying");
          setAnnouncement("Service access was refreshed for this guest. Requerying before exact retry.");
          void reconcile(envelope, true);
        } else if (authority) {
          clearEnvelope();
          setPhase("authority");
          setAnnouncement("Service access needs recovery.");
        } else {
          setPhase("outcome-unknown");
          setAnnouncement("The outcome is unknown. Requerying before exact retry.");
          void reconcile(envelope);
        }
        return;
      }
      const next = decodeServiceResponse(await response.json());
      if (next.revision < current.revision) throw new Error("Delayed response rejected.");
      clearEnvelope();
      const newLedgerRow = next.disposition === "committed" && next.announceCeremony && next.ledgerRows.length === current.ledgerRows.length + 1
        ? next.ledgerRows.at(-1) ?? null : null;
      if (newLedgerRow) {
        setCeremonyRow(newLedgerRow);
        setAnnouncement(newLedgerRow.serveFeedback.text);
        publishView(next, envelope, newLedgerRow.serveFeedback.text, "feedback", token);
      } else {
        publishView(next, envelope, undefined, next.phase === "SETTLED" || next.phase === "ABANDONED" ? "task" : "choice", token);
      }
    } catch {
      if (token === generation.current && envelopeRef.current === envelope) {
        setPhase("outcome-unknown");
        setAnnouncement("The outcome is unknown. Requery before retrying the retained intent.");
        void reconcile(envelope);
      }
    } finally {
      timeout.clear();
    }
  }, [beginRequest, clearEnvelope, publishView, reconcile]);

  const recoverAuthority = useCallback(async () => {
    if (envelopeRef.current) return;
    const token = beginRequest();
    setPhase("loading");
    setAnnouncement("Resetting service access without exposing credentials.");
    try {
      const reset = await postJson(COOKIE_RESET_PATH, "{}");
      if (!reset.ok || token !== generation.current) throw new Error("reset");
      const issue = await postJson(GUEST_ISSUE_PATH, JSON.stringify({ consentVersion: "first-service-browser-v1" }));
      if (!issue.ok || token !== generation.current) throw new Error("issue");
      const issued = await issue.json() as unknown;
      if (!issued || typeof issued !== "object" || Array.isArray(issued) || JSON.stringify(issued) !== '{"issued":true}') throw new Error("issue");
      await query(false, "task");
    } catch {
      if (token === generation.current) {
        setPhase("unavailable");
        setAnnouncement("Service recovery is temporarily unavailable.");
      }
    }
  }, [beginRequest, query]);

  const activeOrder = view?.orders.find((order) => order.active) ?? null;
  const selected = view?.choices.find((choice) => choice.id === selectedChoice) ?? null;
  const terminal = view?.phase === "SETTLED" || view?.phase === "ABANDONED";
  const canAbandon = view && ["OPEN", "CLOSING"].includes(view.phase) && phase === "ready";
  const primaryLabel = selected?.actionLabel.text ?? view?.prompt.text ?? "Continue";
  const transportLabel = useMemo(() => ({ loading: "Loading saved service", ready: "Server acknowledged", sending: "Saving command", "outcome-unknown": "Outcome unknown", requerying: "Requerying saved state", unavailable: "Runtime unavailable", authority: "Service access unavailable" }[phase]), [phase]);

  return (
    <main className="counter-shell">
      <header className="counter-header">
        <div className="wordmark" aria-label="Samurai Sushi counter ledger">
          <span className="wordmark-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>Samurai Sushi</strong><small>Counter Ledger</small></span>
        </div>
        <div className="identity-plaque">
          <strong>{view?.identityLabel ?? "Guest play · no wallet"}</strong>
          <small>{transportLabel}</small>
        </div>
      </header>

      <section className="service-counter" aria-label="First evening service">
        <section className="prep-plane" aria-labelledby="service-task">
          {view ? (
            <div className="active-prep">
              {phase === "authority" || phase === "unavailable" ? <section className="blocking-banner" role="alert"><strong>{phase === "authority" ? "Service access needs recovery." : "The saved service is temporarily unavailable."}</strong><p>The last saved view is read-only. {phase === "authority" ? "You may explicitly open a fresh guest service." : "Requery without changing browser-managed cookies."}</p><button className="primary-action" type="button" onClick={() => void (phase === "authority" ? recoverAuthority() : query())}>{phase === "authority" ? "Recover service access" : "Requery saved service"}</button></section> : null}
              <div className="task-heading">
                <div>
                  <p>{activeOrder ? `${activeOrder.dish.text} · ${activeOrder.guest.text}` : "First evening service"}</p>
                  <h1 id="service-task" tabIndex={-1} ref={taskRef}>{view.prompt.text}</h1>
                </div>
                <span className="revision-stamp">Saved {view.revision}</span>
              </div>

              {view.correctiveCue ? <p className="corrective-cue">{view.correctiveCue.text}</p> : null}

              <div className="work-surface">
                {ceremonyRow ? (
                  <section className="serve-ceremony" aria-labelledby="serve-feedback-heading">
                    <PixelAsset asset={view.orders.find((order) => order.orderId === ceremonyRow.orderId)!.dishAsset} scale={3} />
                    <div><h2 id="serve-feedback-heading" ref={feedbackRef} tabIndex={-1}>{ceremonyRow.outcome.text}</h2><p>{ceremonyRow.serveFeedback.text}</p><button className="primary-action" type="button" onClick={() => { setCeremonyRow(null); window.requestAnimationFrame(() => choicesRef.current?.querySelector<HTMLInputElement>("input")?.focus()); }}>Next order</button></div>
                  </section>
                ) : <>
                {activeOrder ? <PixelAsset asset={activeOrder.dishAsset} className="hero-pixel" scale={3} /> : <CounterScene view={view} />}
                {terminal ? (
                  <section className="terminal-state" aria-label="Service result">
                    <PixelAsset asset={view.unlock} scale={2} />
                    <div><strong>{view.phase === "SETTLED" ? "Service settled" : "Service abandoned"}</strong><p>{view.phase === "SETTLED" ? view.facts.at(-1)?.text : "No settlement or unlock was recorded."}</p>{view.phase === "SETTLED" ? <button className="primary-action" type="button" disabled={phase !== "ready"} onClick={() => { setShowLedger(true); window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".ingredient-rail")?.focus()); }}>Keep playing</button> : <button className="primary-action" type="button" disabled={phase !== "ready" || view.choices.length !== 1} onClick={() => void execute(view.choices[0]!)}>{view.choices[0]?.actionLabel.text}</button>}</div>
                  </section>
                ) : null}
                </>}
              </div>

            </div>
          ) : (
            <div className="threshold-state">
              <div className="threshold-scene"><span className="scene-placeholder" aria-hidden="true" /></div>
              <div className="threshold-copy">
                <h1 id="service-task" tabIndex={-1} ref={taskRef}>{phase === "authority" ? "Service access needs recovery." : "Returning to the counter."}</h1>
                <p>{phase === "authority" ? "Open a fresh guest service through the strict cookie recovery path. No account or wallet details are shown." : "The last server-acknowledged service state will appear here. Nothing is restored from browser storage."}</p>
                {phase === "authority" ? <button className="primary-action" type="button" onClick={() => void recoverAuthority()}>Open guest service</button> : null}
                {phase === "unavailable" ? <button className="primary-action" type="button" onClick={() => void query()}>Try service again</button> : null}
              </div>
            </div>
          )}
        </section>

        <aside className="ingredient-rail" aria-label="Mise en place and ledger" tabIndex={showLedger ? -1 : undefined}>
          <div className="rail-heading"><h2>Mise en place</h2><span>saved service</span></div>
          {view && !terminal ? <details className="mise-sheet" open={miseOpen} onToggle={(event) => setMiseOpen(window.innerWidth >= 1180 ? true : event.currentTarget.open)}>
            <summary>Choose and inspect</summary>
            {view.choices.length > 0 ? <fieldset ref={choicesRef} className="legal-choices" disabled={phase !== "ready" || Boolean(inFlight)}>
              <legend>Choose one</legend>
              {view.choices.map((choice) => <label key={choice.id} className={selectedChoice === choice.id ? "choice-tile is-selected" : "choice-tile"}>
                <input type="radio" name="service-choice" value={choice.id} checked={selectedChoice === choice.id} onChange={() => setSelectedChoice(choice.id)} />
                {choice.asset ? <PixelAsset asset={choice.asset} scale={choice.asset.width >= 64 ? 1 : 2} /> : <span className="choice-mark" aria-hidden="true" />}
                <span><strong>{choice.label.text}</strong><small>Available now</small></span>
              </label>)}
            </fieldset> : null}
            <div className="service-facts"><strong>Service facts</strong><ul>{view.facts.map((fact) => <li key={fact.ref}>{fact.text}</li>)}</ul><p>Role labels and culinary content remain review-pending. This is game disclosure, not food-safety guidance.</p></div>
            {view.choices.length > 0 ? <div className="perform-action"><button className="primary-action" type="button" disabled={!selected || phase !== "ready" || Boolean(inFlight)} onClick={() => selected && void execute(selected.id)}>{phase === "sending" || phase === "requerying" ? "Saving…" : primaryLabel}</button><small>No step changes until the server acknowledges it.</small></div> : null}
            <div className="recovery-actions">
              {phase === "outcome-unknown" && inFlight ? <button type="button" className="text-action" onClick={() => void reconcile(inFlight)}>Requery and recover exact command</button> : null}
              {phase === "unavailable" ? <button type="button" className="text-action" onClick={() => void query()}>Requery saved service</button> : null}
              {canAbandon ? <button ref={abandonButtonRef} type="button" className="danger-text-action" onClick={() => setAbandonOpen(true)}>End shift early</button> : null}
            </div>
          </details> : null}
          {view && terminal ? <CounterScene view={view} /> : null}
          <div className="ledger-list">
            {view?.ledgerRows.map((row) => (
              <article key={row.orderId}><strong>{row.dish.text}</strong><span>{row.outcome.text}</span><p>{row.serveFeedback.text}</p></article>
            ))}
            {view?.ledgerRows.length === 0 ? <p>No served order has entered the ledger yet.</p> : null}
          </div>
          {view?.restoration ? <div className="restoration-proof"><PixelAsset asset={view.restoration} scale={1} /><span>Saved cosmetic restoration</span></div> : null}
          {view?.phase === "SETTLED" ? <ReceiptReviewDoorway /> : null}
          <details className="runtime-disclosure"><summary>Service evidence</summary><p>Same-origin, no-store requests. Runtime details remain server-side.</p></details>
          <div className="truth-strip"><span>Review-pending content</span><strong>Provisional role labels</strong><small>No cultural or public-release approval is claimed.</small></div>
        </aside>

        <aside className="order-rail" aria-label="Tonight's orders">
          <div className="rail-heading"><h2>Tonight&apos;s rail</h2><span>{view?.orders.length ?? 3} orders</span></div>
          <div className="mobile-order-strip">{activeOrder ? <><strong>{activeOrder.dish.text}</strong><span>{activeOrder.status.text}</span></> : <span>Awaiting saved service</span>}</div>
          <ol className="order-list">
            {view?.orders.map((order) => (
              <li key={order.orderId} className={order.active ? "is-active" : ""}>
                <PixelAsset asset={order.portrait} scale={2} />
                <span><strong>{order.dish.text}</strong><small>{order.guest.text}</small></span>
                <span className="order-state">{order.status.text}<small>{order.stepIndex}/{order.stepTotal}</small></span>
              </li>
            )) ?? [0, 1, 2].map((index) => <li key={index} className="order-skeleton">Awaiting server</li>)}
          </ol>
          <div className="rail-note"><strong>Guest play · no wallet</strong><span>Only server-acknowledged projections render. No gameplay authority is stored in this browser.</span></div>
        </aside>
      </section>

      <p className="atomic-live" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>

      <nav className="bottom-nav" aria-label="Primary"><a href="#service-task" aria-current="page">Counter</a><button type="button" disabled>Stores</button><button type="button" disabled>Recipes</button><button type="button" disabled>Ledger</button></nav>

      {abandonOpen ? (
          <dialog ref={abandonDialogRef} aria-labelledby="abandon-title" aria-describedby="abandon-copy" className="abandon-dialog"
            onCancel={(event) => { event.preventDefault(); setAbandonOpen(false); window.requestAnimationFrame(() => abandonButtonRef.current?.focus()); }}
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)")];
              const first = controls[0];
              const last = controls.at(-1);
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
              else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }}
            onMouseDown={(event) => { if (event.target === event.currentTarget) { setAbandonOpen(false); window.requestAnimationFrame(() => abandonButtonRef.current?.focus()); } }}>
            <h2 id="abandon-title">End this shift early?</h2><p id="abandon-copy">The server will discard unfinished preparation. No settlement or unlock will be recorded.</p>
            <div><button ref={cancelAbandonRef} className="text-action" type="button" onClick={() => { setAbandonOpen(false); window.requestAnimationFrame(() => abandonButtonRef.current?.focus()); }}>Keep serving</button><button className="danger-action" type="button" onClick={() => { setAbandonOpen(false); if (view?.abandonChoice) void execute(view.abandonChoice); }}>End shift</button></div>
          </dialog>
      ) : null}
    </main>
  );
}
