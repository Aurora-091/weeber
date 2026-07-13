import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Router } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";
import App from "./app.tsx";
import { TrackingScripts } from "./components/tracking-scripts";
import { useBodyThemeSync } from "./lib/body-theme-sync";

function BodyThemeSync() {
	useBodyThemeSync();
	return null;
}

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<Router>
				<BodyThemeSync />
				<TrackingScripts />
				<App />
			</Router>
		</QueryClientProvider>
	</StrictMode>,
);
