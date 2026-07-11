import { defineConfig } from "tsup";

// Publish-ready ESM build. esbuild bundles the JS (resolving the `.ts`
// extension imports the source uses), and `tsc` emits the `.d.ts` declarations
// via tsconfig.build.json (`emitDeclarationOnly` is compatible with
// `allowImportingTsExtensions`, unlike a plain emit — the root cause of the
// earlier TS5096 build break).
export default defineConfig({
    entry: ["src/index.ts", "src/cli.ts"],
    format: ["esm"],
    target: "es2022",
    dts: { compilerOptions: { emitDeclarationOnly: true } },
    clean: true,
    sourcemap: true,
    treeshake: true,
    keepNames: true,
});
