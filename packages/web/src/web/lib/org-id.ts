import { useState } from "react";

/**
 * Which org the Agents/Analytics pages are viewing — persisted in
 * localStorage so it survives a refresh. There's no org-switcher/auth
 * infrastructure yet (the dashboard uses one shared admin key that sees
 * every org — see admin-key.ts), so this is just a plain client-side
 * selection, not an access-scoping mechanism.
 */
const STORAGE_KEY = "vent_selected_org_id";

export function useSelectedOrgId(): [string, (id: string) => void] {
  const [orgId, setOrgIdState] = useState(() => localStorage.getItem(STORAGE_KEY) ?? "");

  function setOrgId(id: string) {
    localStorage.setItem(STORAGE_KEY, id);
    setOrgIdState(id);
  }

  return [orgId, setOrgId];
}
