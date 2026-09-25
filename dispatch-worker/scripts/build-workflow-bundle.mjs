// Pre-bundles workflow code at build time. `workflowsPath` (bundling at Worker
// startup) is fine for local development but the wrong choice for production
// — it's slow and re-runs webpack every time the container starts. worker.ts
// prefers this pre-built bundle when present and falls back to `workflowsPath`
// only when it isn't (e.g. running straight from source without a build step).
import { bundleWorkflowCode } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const workflowsPath = fileURLToPath(new URL("../src/workflows/dispatch-story-workflow.ts", import.meta.url));
const outputPath = fileURLToPath(new URL("../dist/workflow-bundle.js", import.meta.url));

const { code } = await bundleWorkflowCode({ workflowsPath });
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, code);

console.log(`Workflow bundle written to ${join("dist", "workflow-bundle.js")} (${code.length} bytes)`);
