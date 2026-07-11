import { useEffect } from "react";

/** Sets document.title for the duration of the mount, restoring the
 * previous title on unmount — ported from Vocalist's usePageTitle hook. */
export function usePageTitle(title: string) {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = `${title} \u00b7 Weeber`;
    return () => {
      document.title = prevTitle;
    };
  }, [title]);
}
