import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Samurai Sushi — First Shift",
  description: "A walletless first look at the Moonwake Sushi counter.",
};

const designContract = `
THESIS: The counter is the interface; refuse the game-landing-page hero and begin at the working pass.
OWN-WORLD: Sumi lacquer rails, rice-paper work fields, nori controls, vermilion order marks, indigo focus, two-pixel rules.
STORY: Enter as a guest, read one order, prepare exact ingredients, serve, and understand that no wallet is involved.
FIRST VIEWPORT: Order chits left, one broad cutting-board task plane center, ingredient receipt rail right, primary start action on the board.
FORM: Mise-en-place ribbon, the fifth grounded surface structure, seed 0f65c4b6.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
`.trim();

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <script
          id="counter-ledger-design-contract"
          type="application/x-samurai-design-contract"
          dangerouslySetInnerHTML={{ __html: designContract }}
        />
        {children}
      </body>
    </html>
  );
}
