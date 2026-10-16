import solidPlugin from "@opentui/solid/bun-plugin"

// OpenCode applies the Solid JSX transform only to files outside node_modules,
// so package installs load this prebuilt bundle instead of src/tui.tsx.
const result = await Bun.build({
  entrypoints: ["./src/tui.tsx"],
  outdir: "./dist",
  target: "bun",
  format: "esm",
  external: ["@opencode/*", "@opentui/*", "solid-js", "solid-js/*"],
  plugins: [solidPlugin],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
