// Registers a happy-dom global DOM so React components can render under `bun test`.
// Wired in via bunfig.toml `[test] preload`. Without this, anything that touches
// `document`/`window` (i.e. every component test) throws "document is not defined".
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost:4200" });
