import { defineConfig } from "tsup";

// Publish-ready ESM build. esbuild bundles the JS (resolving the `.ts`
// extension imports the source uses), and `tsc` emits the `.d.ts` declarations
// via tsconfig.build.json (`emitDeclarationOnly` is compatible with
// `allowImportingTsExtensions`, unlike a plain emit — the root cause of the
// earlier TS5096 build break).
export default defineConfig({
    // The three agent-framework adapters (#2312) are separate entry points —
    // not re-exported from `src/index.ts` — so importing the core SDK never
    // pulls in `@langchain/langgraph-checkpoint` (a hard, non-optional import
    // inside `adapters/langgraph.ts`, since LangGraph's Pregel loop does
    // `instanceof` checks on the checkpointer). `langchain`/`llamaindex`
    // are peer-optional too, but `adapters/langchain.ts` and
    // `adapters/llamaindex.ts` duck-type their target framework and never
    // import it, so those two build clean with zero peers installed.
    entry: [
        "src/index.ts",
        "src/cli.ts",
        "src/adapters/langchain.ts",
        "src/adapters/llamaindex.ts",
        "src/adapters/langgraph.ts",
    ],
    format: ["esm"],
    target: "es2022",
    dts: { compilerOptions: { emitDeclarationOnly: true } },
    clean: true,
    sourcemap: true,
    treeshake: true,
    keepNames: true,
});
