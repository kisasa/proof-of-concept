import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// temporal-namespace.test.ts imports the Temporal Cloud provider bindings,
// which exist only after `cdktn get` generates them into .gen/ (gitignored).
// Without them that file cannot even load, so a fresh checkout's run would
// always show a failure unrelated to any change. Skip it until the bindings
// exist, and say so, so a green run means every test that can run passed.
const TEMPORAL_BINDINGS = fileURLToPath(new URL("./.gen/providers/temporalcloud", import.meta.url));
const NEEDS_GENERATED_BINDINGS = ["constructs/temporal-namespace.test.ts"];
const bindingsPresent = existsSync(TEMPORAL_BINDINGS);

if (!bindingsPresent) {
  console.warn(
    `Skipping ${NEEDS_GENERATED_BINDINGS.join(", ")}: no generated Temporal Cloud bindings in .gen/. ` +
      "Run `npx cdktn get` (needs a cdktf.json) to include it.",
  );
}

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: bindingsPresent ? configDefaults.exclude : [...configDefaults.exclude, ...NEEDS_GENERATED_BINDINGS],
  },
});
