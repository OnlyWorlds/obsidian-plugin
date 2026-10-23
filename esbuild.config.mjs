import esbuild from "esbuild";
import process from "process";
import { pluginBuildOptions } from "./esbuild.options.mjs";

const prod = (process.argv[2] === "production");

// The options live in esbuild.options.mjs, which the test build reads too.
const context = await esbuild.context(pluginBuildOptions(prod));

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
