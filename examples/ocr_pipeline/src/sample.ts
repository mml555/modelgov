import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

// A fake receipt with a couple of PII-ish fields (name, email) so you can see
// the extractor pull them out — and, with safety=balanced, the gateway mask them.
const RECEIPT = `NORTHWIND CAFE
123 Market Street, Springfield

Receipt #  A-20428
Date: 2026-06-30
Cashier: Dana Lopez
Customer: jordan.miles@example.com

Cappuccino          x2     8.00
Blueberry Muffin    x1     3.50
Sparkling Water     x1     2.25

Subtotal                  13.75
Tax (8%)                   1.10
TOTAL                     14.85

Paid: VISA ****4217
Thank you!`;

const OUT = fileURLToPath(new URL("../sample-receipt.png", import.meta.url));

/**
 * Generate a sample receipt PNG using ImageMagick's `caption:` (its built-in
 * text renderer — no SVG delegate or fonts config needed). Gives the demo
 * something to run against with zero external files.
 */
async function main(): Promise<void> {
  try {
    await exec("convert", [
      "-background", "white",
      "-fill", "black",
      "-font", "Courier",
      "-pointsize", "22",
      "-size", "560x",
      `caption:${RECEIPT}`,
      "-bordercolor", "white",
      "-border", "30",
      OUT,
    ]);
  } catch {
    // ImageMagick v7 uses `magick` as the primary binary.
    try {
      await exec("magick", [
        "-background", "white",
        "-fill", "black",
        "-font", "Courier",
        "-pointsize", "22",
        "-size", "560x",
        `caption:${RECEIPT}`,
        "-bordercolor", "white",
        "-border", "30",
        OUT,
      ]);
    } catch (err) {
      console.error(
        `Could not run ImageMagick (install it, or drop your own image/PDF and skip this step).\n${(err as Error).message}`,
      );
      process.exit(1);
    }
  }
  console.log(`Wrote ${OUT}`);
  console.log(`Now run:  pnpm extract ${OUT}`);
}

void main();
