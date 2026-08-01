"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { NetworkProfile } from "@samurai-sushi/network";

const serviceSteps = [
  { action: "Season the rice", station: "Rice hearth", ingredient: "rice" },
  { action: "Place the nori", station: "Rolling mat", ingredient: "nori" },
  { action: "Set the cucumber", station: "Prep board", ingredient: "cucumber" },
  { action: "Roll and cut", station: "Rolling mat", ingredient: "none" },
] as const;

const orders = [
  { guest: "The ceramicist", dish: "Kappa maki", state: "active" },
  { guest: "The fishmonger", dish: "Tamago nigiri", state: "waiting" },
  { guest: "The courier", dish: "Salmon nigiri", state: "waiting" },
] as const;

const ingredients = [
  { id: "rice", label: "Sushi rice", detail: "Seasoned · contains no declared MVP allergens" },
  { id: "nori", label: "Nori", detail: "Seaweed sheet · roll vessel" },
  { id: "cucumber", label: "Cucumber", detail: "Plant · narrow baton cut" },
] as const;

export function CounterShell({
  network,
  runtimeRevision,
}: Readonly<{ network: NetworkProfile; runtimeRevision: string }>) {
  const [started, setStarted] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [selectedIngredient, setSelectedIngredient] = useState<string | null>(null);
  const [showOwnership, setShowOwnership] = useState(false);
  const [served, setServed] = useState(false);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const ingredientRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const currentStep = serviceSteps[Math.min(stepIndex, serviceSteps.length - 1)];
  const complete = stepIndex >= serviceSteps.length;
  const requiredIngredient = currentStep?.ingredient === "none" ? null : currentStep?.ingredient;
  const canAdvance = complete || requiredIngredient === null || selectedIngredient === requiredIngredient;
  const status = useMemo(() => {
    if (!started) return "The curtain is down. Your first shift is ready.";
    if (served) return "The ceramicist smiles. Your first plate has been served.";
    if (complete) return "Kappa maki is ready at the pass.";
    if (requiredIngredient && selectedIngredient !== requiredIngredient) {
      return `Choose ${ingredients.find((item) => item.id === requiredIngredient)?.label ?? "the next ingredient"}.`;
    }
    return `${currentStep?.action} at the ${currentStep?.station}.`;
  }, [complete, currentStep, requiredIngredient, selectedIngredient, served, started]);

  useEffect(() => {
    if (!started) return;
    if (complete) {
      actionButtonRef.current?.focus();
      return;
    }
    if (requiredIngredient) ingredientRefs.current[requiredIngredient]?.focus();
    else actionButtonRef.current?.focus();
  }, [complete, requiredIngredient, started, stepIndex]);

  useEffect(() => {
    if (selectedIngredient === requiredIngredient) actionButtonRef.current?.focus();
  }, [requiredIngredient, selectedIngredient]);

  function advance() {
    if (!canAdvance || complete) return;
    setStepIndex((value) => value + 1);
    setSelectedIngredient(null);
  }

  function resetShift() {
    setStarted(false);
    setStepIndex(0);
    setSelectedIngredient(null);
    setServed(false);
  }

  return (
    <main className="counter-shell">
      <header className="counter-header">
        <div className="wordmark" aria-label="Samurai Sushi, Moonwake counter">
          <span className="wordmark-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>Samurai Sushi</strong><small>Moonwake counter</small></span>
        </div>
        <div className="network-plaque" aria-label={`Network ${network.network}, chain ${network.chainId}`}>
          <span className="status-lamp" aria-hidden="true" />
          <span><strong>{network.network}</strong><small>{network.chainId} · runtime {runtimeRevision.slice(0, 7)}</small></span>
        </div>
      </header>

      <section className="service-counter" aria-label="First shift counter">
        <aside className="order-rail" aria-label="Tonight's orders">
          <div className="rail-heading">
            <h2>Tonight&apos;s rail</h2>
            <span>3 orders</span>
          </div>
          <ol className="order-list">
            {orders.map((order, index) => (
              <li key={order.dish} className={started && index === 0 ? "is-active" : ""}>
                <span className="order-number">{String(index + 1).padStart(2, "0")}</span>
                <span><strong>{order.dish}</strong><small>{order.guest}</small></span>
                <span className="order-state">{started && index === 0 ? (served ? "served" : complete ? "ready" : "making") : order.state}</span>
              </li>
            ))}
          </ol>
          <div className="rail-note">
            <strong>No wallet during service.</strong>
            <span>Play, results, and recovery stay local in this Phase 0 shell.</span>
          </div>
        </aside>

        <aside className="ingredient-rail" aria-label="Mise en place">
          <div className="rail-heading">
            <h2>Mise en place</h2>
            <span>select + place</span>
          </div>
          <div className="ingredient-list">
            {ingredients.map((ingredient) => (
              <button
                className="ingredient-tile"
                data-ingredient={ingredient.id}
                aria-pressed={selectedIngredient === ingredient.id}
                key={ingredient.id}
                onClick={() => setSelectedIngredient(ingredient.id)}
                ref={(node) => { ingredientRefs.current[ingredient.id] = node; }}
                type="button"
                disabled={!started || complete}
              >
                <span className="ingredient-pixel" aria-hidden="true"><i /><i /></span>
                <span><strong>{ingredient.label}</strong><small>{ingredient.detail}</small></span>
              </button>
            ))}
          </div>
          <div className="truth-strip">
            <span>Prototype content</span>
            <strong>Culinary review pending</strong>
            <small>Game disclosure only; not real-world food-safety guidance.</small>
          </div>
        </aside>

        <section className="prep-plane" aria-labelledby="shift-title">
          {!started ? (
            <div className="threshold-state">
              <div className="counter-scene" aria-hidden="true">
                <span className="lantern" /><span className="curtain curtain-one" /><span className="curtain curtain-two" />
                <span className="board"><i /><i /><i /></span>
              </div>
              <div className="threshold-copy">
                <h1 id="shift-title">Your counter opens tonight.</h1>
                <p>Prepare three authored orders and learn the rhythm of a tiny evening service. No wallet, token, or timer pressure.</p>
                <div className="threshold-actions">
                  <button className="primary-action" type="button" onClick={() => setStarted(true)}>Start first shift</button>
                  <button className="text-action" type="button" aria-expanded={showOwnership} onClick={() => setShowOwnership((value) => !value)}>How ownership works</button>
                </div>
                {showOwnership ? (
                  <p className="ownership-note">The first shift is guest play. An optional, non-financial service keepsake appears only after a complete settled service; this shell never asks for a wallet.</p>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="active-prep">
              <div className="task-heading">
                <div>
                  <p>Kappa maki · order 1 of 3</p>
                  <h1 id="shift-title">{served ? "First plate served" : complete ? "Ready for the pass" : currentStep?.action}</h1>
                </div>
                <span className="step-count">{Math.min(stepIndex + 1, serviceSteps.length)} / {serviceSteps.length}</span>
              </div>

              <div className="cutting-board" data-step={stepIndex}>
                <div className="board-ruler" aria-hidden="true">{serviceSteps.map((step, index) => <i key={step.action} className={index < stepIndex ? "done" : index === stepIndex ? "current" : ""} />)}</div>
                <div className="dish-build" aria-label={complete ? "Completed kappa maki" : `Preparation step ${stepIndex + 1}`}>
                  <span className={`rice-shape ${stepIndex >= 1 ? "is-set" : ""}`} />
                  <span className={`nori-shape ${stepIndex >= 2 ? "is-set" : ""}`} />
                  <span className={`cucumber-shape ${stepIndex >= 3 ? "is-set" : ""}`} />
                  <span className={`roll-shape ${complete ? "is-set" : ""}`}><i /><i /><i /></span>
                </div>
                <p className="live-status" role="status" aria-live="polite">{status}</p>
              </div>

              <div className="prep-actions">
                {served ? (
                  <button ref={actionButtonRef} className="primary-action" type="button" onClick={resetShift}>Reset prototype shift</button>
                ) : complete ? (
                  <button ref={actionButtonRef} className="primary-action" type="button" onClick={() => setServed(true)}>Serve kappa maki</button>
                ) : (
                  <button ref={actionButtonRef} className="primary-action" type="button" onClick={advance} disabled={!canAdvance}>
                    Complete: {currentStep?.action}
                  </button>
                )}
                <p>{served ? "“Clean cuts. The cucumber still has its snap.” — The ceramicist" : complete ? "Serve the plate to settle this prototype order." : `Station: ${currentStep?.station}`}</p>
              </div>
            </div>
          )}
        </section>
      </section>

      <nav className="bottom-nav" aria-label="Primary">
        <a href="#shift-title" aria-current="page">Counter</a>
        <button type="button" disabled>Stores</button>
        <button type="button" disabled>Recipes</button>
        <button type="button" disabled>Ledger</button>
      </nav>
    </main>
  );
}
