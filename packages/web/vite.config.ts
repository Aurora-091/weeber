import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite"
import path from "path";
import fs from "fs";
import honoDevPlugin from "./vite/plugins/hono-dev-plugin";

const root = path.resolve(__dirname, "../..");

/**
 * Regenerates dist/robots.txt for the admin/merchant surfaces at build time.
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
	const env = loadEnv(mode, root, '');
	Object.assign(process.env, env);
	const surface = env.VITE_APP_SURFACE || "all";
	// HTML env replacement (%VITE_ROBOTS_META%) leaves the placeholder untouched
	// if the var is unset anywhere -- always give it a real value so index.html
	// never ships the literal "%VITE_ROBOTS_META%" string as its meta tag content.
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
