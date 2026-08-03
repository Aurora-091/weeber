import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite"
import path from "path";
import fs from "fs";
import honoDevPlugin from "./vite/plugins/hono-dev-plugin";

const root = path.resolve(__dirname, "../..");

/**
 * Regenerates dist/robots.txt for the admin/user surfaces at build time.
 * The static packages/web/public/robots.txt is written for the public
 * marketing surface (Disallow /dashboard, /app -- the combined single-deploy
 * paths). On a dedicated admin.weeber.ai or app.weeber.ai build those pages
 * serve BARE paths (no prefix), so the shared file's rules don't cover them
 * and they'd otherwise be fully crawlable + advertise www's sitemap. This
 * plugin overwrites the copied file post-build with a blanket Disallow for
 * any surface other than "public"/"all".
 */
function surfaceRobotsPlugin(surface: string): Plugin {
	return {
		name: "surface-robots-txt",
		apply: "build",
		closeBundle() {
			if (surface === "public" || surface === "all") return;
			const outPath = path.resolve(__dirname, "dist/robots.txt");
			fs.writeFileSync(
				outPath,
				`# ${surface} surface -- internal, never indexed.\nUser-agent: *\nDisallow: /\n`,
			);
		},
	};
}

export default defineConfig(({ mode }) => {
	// `loadEnv(mode, root, '')` uses an EMPTY prefix, so it loads EVERY key in the
	// root .env — including `NODE_ENV=development`, which .env and .env.example:1
	// both ship.
	//
	// That has a non-obvious consequence. loadEnv() is not a pure read: when the
	// env file declares NODE_ENV it sets `process.env.VITE_USER_NODE_ENV` as a side
	// effect, and after this factory returns Vite uses VITE_USER_NODE_ENV to
	// override NODE_ENV (it only skips that when NODE_ENV was already set in the
	// real environment). So merely CALLING loadEnv here turned every `vite build`
	// into a development build:
	//   - import.meta.env.DEV === true, so DEV-gated code shipped — the /__preview
	//     harness route was live in the built output
	//   - the dev JSX transform ran, embedding absolute source paths
	//     (/home/user/...) and development React in dist/
	//   - `vite preview` therefore served a DEV bundle, so the e2e suite was not
	//     testing the shipped artifact the way playwright.config.ts claims
	// Deleting the file's NODE_ENV is not enough; the side effect has already
	// fired by then, which is why `NODE_ENV=production vite build` was the only
	// thing that used to work.
	//
	// NODE_ENV must come from the real environment or Vite's own mode, never from
	// an env file. Everything else keeps its previous behaviour.
	// The delete must come AFTER the Object.assign: an empty prefix also makes
	// loadEnv echo back the whole of process.env, so the VITE_USER_NODE_ENV it just
	// set is inside `env` too and assigning would immediately restore it.
	const { NODE_ENV: _fileNodeEnv, VITE_USER_NODE_ENV: _viteUserNodeEnv, ...env } = loadEnv(mode, root, '');
	Object.assign(process.env, env);
	delete process.env.VITE_USER_NODE_ENV;
	const surface = env.VITE_APP_SURFACE || "all";
	// HTML env replacement (%VITE_ROBOTS_META%) leaves the placeholder untouched
	// if the var is unset anywhere -- always give it a real value so index.html
	// never ships the literal "%VITE_ROBOTS_META%" string as its meta tag content.
	// The /__harness route (Phase 0.6, drives e2e/visual.spec.ts) is gated on
	// VITE_UI_HARNESS === "1". Vite only inlines VITE_* vars that are DEFINED —
	// an unset one stays a runtime `import.meta.env.VITE_UI_HARNESS` lookup, which
	// Rollup cannot fold to false, so the harness chunk and every private page it
	// imports ship in the production bundle. Verified: without this default the
	// string "unknown harness key" was present in dist/assets. Pinning it to "0"
	// makes the gate a literal `"0" === "1"` and the whole branch dead code.
	if (!process.env.VITE_UI_HARNESS) {
		process.env.VITE_UI_HARNESS = "0";
	}
	if (!process.env.VITE_ROBOTS_META) {
		process.env.VITE_ROBOTS_META =
			surface === "public" || surface === "all"
				? "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
				: "noindex, nofollow";
	}

	return {
		plugins: [honoDevPlugin(), react(), tailwind(), surfaceRobotsPlugin(surface)],
		resolve: {
			alias: {
				"@": path.resolve(__dirname, "./src/web"),
			},
		},
		server: {
			allowedHosts: true,
			hmr: { overlay: false, },
			cors: false
		}
	};
});
