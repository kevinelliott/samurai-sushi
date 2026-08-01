import { expect, test } from "@playwright/test";

test("walletless first-shift shell is operable and truthful", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your counter opens tonight." })).toBeVisible();
  await expect(page.getByText("NetXtJqPyJGB6Pc")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start first shift" })).toBeVisible();
  await expect(page.getByRole("button", { name: /wallet/i })).toHaveCount(0);
  await expect(page.locator("html")).toHaveJSProperty("scrollWidth", await page.locator("html").evaluate((node) => node.clientWidth));

  await page.screenshot({
    path: testInfo.project.name === "desktop" ? ".scratch-desktop.png" : ".scratch-mobile.png",
    fullPage: false,
  });

  await page.getByRole("button", { name: "Start first shift" }).click();
  await expect(page.getByRole("heading", { name: "Season the rice" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Sushi rice/ })).toBeFocused();
  await page.getByRole("button", { name: /Sushi rice/ }).click();
  await expect(page.getByRole("button", { name: "Complete: Season the rice" })).toBeFocused();
  await page.getByRole("button", { name: "Complete: Season the rice" }).click();
  await expect(page.getByRole("heading", { name: "Place the nori" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Nori/ })).toBeFocused();
  await page.getByRole("button", { name: /^Nori/ }).click();
  await page.getByRole("button", { name: "Complete: Place the nori" }).click();
  await page.getByRole("button", { name: /^Cucumber/ }).click();
  await page.getByRole("button", { name: "Complete: Set the cucumber" }).click();
  await expect(page.getByRole("button", { name: "Complete: Roll and cut" })).toBeFocused();
  await page.getByRole("button", { name: "Complete: Roll and cut" }).click();
  await expect(page.getByRole("button", { name: "Serve kappa maki" })).toBeFocused();
  await page.getByRole("button", { name: "Serve kappa maki" }).click();
  await expect(page.getByRole("heading", { name: "First plate served" })).toBeVisible();
  await expect(page.getByText(/Clean cuts/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset prototype shift" })).toBeFocused();
  if (testInfo.project.name === "desktop") {
    await page.screenshot({ path: ".scratch-active-desktop.png", fullPage: false });
  }
});
