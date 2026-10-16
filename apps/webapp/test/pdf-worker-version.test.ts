import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * THE VENDORED PDF WORKER MUST MATCH THE INSTALLED pdfjs-dist, OR PDF PREVIEW BREAKS SILENTLY.
 *
 * `AttachmentPreview` renders PDFs with pdf.js and points `workerSrc` at a worker committed to
 * `public/pdf.worker.min.mjs` (webpack cannot bundle the `.mjs` worker, and a CDN is refused by
 * `worker-src 'self'`). pdf.js throws on a main-thread/worker VERSION MISMATCH, so a bump of the
 * `pdfjs-dist` dependency without recopying the worker would break every PDF preview on the live
 * host while every unit test stayed green. This is that guard: bump the dep, this goes red until
 * the worker is recopied.
 */
describe("the vendored pdf.js worker", () => {
  it("is the exact version of the installed pdfjs-dist", () => {
    const require = createRequire(import.meta.url);
    const installed = require("pdfjs-dist/package.json").version as string;

    const workerPath = fileURLToPath(new URL("../public/pdf.worker.min.mjs", import.meta.url));
    const worker = readFileSync(workerPath, "utf8");
    const stamped = /pdfjsVersion = ([0-9][0-9.]*)/.exec(worker)?.[1];

    expect(stamped, "public/pdf.worker.min.mjs carries no version stamp").toBeTruthy();
    expect(
      stamped,
      `worker is ${stamped}, pdfjs-dist is ${installed} — recopy build/pdf.worker.min.mjs into public/`,
    ).toBe(installed);
  });

  /* The file is published as upstream's build, byte for byte, and no content gate reads it: the
   * bytes ARE the review. A worker edited by hand, or copied from another build, reddens here. */
  it("is byte for byte the installed pdfjs-dist build", () => {
    const require = createRequire(import.meta.url);
    const pkg = dirname(require.resolve("pdfjs-dist/package.json"));
    const upstream = readFileSync(join(pkg, "build", "pdf.worker.min.mjs"));
    const ours = readFileSync(fileURLToPath(new URL("../public/pdf.worker.min.mjs", import.meta.url)));
    expect(ours.equals(upstream), "recopy build/pdf.worker.min.mjs from pdfjs-dist into public/").toBe(true);
  });
});
