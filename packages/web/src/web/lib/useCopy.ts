import { useState, useCallback } from "react";
import { toast } from "sonner";

/** Copy-to-clipboard with a toast confirmation — ported from Vocalist's
 * useCopy hook (same behavior, same API). */
export function useCopy(options?: { timeout?: number; message?: string }) {
  const [copied, setCopied] = useState(false);
  const timeout = options?.timeout ?? 1500;
  const message = options?.message ?? "Copied to clipboard";

  const copy = useCallback(
    (text: string) => {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied(true);
          if (message) toast.success(message);
          setTimeout(() => setCopied(false), timeout);
        })
        .catch(() => {
          toast.error("Failed to copy");
        });
    },
    [timeout, message],
  );

  return { copied, copy };
}
