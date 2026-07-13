import { useEffect } from "react";
import { useTheme } from "./theme";

/**
 * Syncs `.theme-weeber` and `.dark` on `<body>` so that Radix portals
 * (Dialog, Sheet, DropdownMenu, Select, Tooltip) which mount to
 * document.body inherit the correct CSS custom properties.
 *
 * Without this, portals fall back to :root's old ember/orange palette
 * since .theme-weeber only lived on the shell wrapper <div>.
 */
export function useBodyThemeSync() {
  const { theme } = useTheme();

  useEffect(() => {
    const body = document.body;
    body.classList.add("theme-weeber");

    if (theme === "dark") {
      body.classList.add("dark");
    } else {
      body.classList.remove("dark");
    }
  }, [theme]);
}
