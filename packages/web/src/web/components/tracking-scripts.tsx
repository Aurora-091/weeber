import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

type TrackingConfig = {
  gtmContainerId: string | null;
  ga4MeasurementId: string | null;
};

export function TrackingScripts() {
  const { data } = useQuery<TrackingConfig>({
    queryKey: ["tracking-config"],
    queryFn: async () => {
      const res = await apiFetch("/api/public/tracking-config");
      if (!res.ok) return { gtmContainerId: null, ga4MeasurementId: null };
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!data?.gtmContainerId) return;
    const id = data.gtmContainerId;

    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtm.js?id=${id}`;
    script.dataset.trackingInjected = "gtm";
    document.head.appendChild(script);

    const initScript = document.createElement("script");
    initScript.dataset.trackingInjected = "gtm-init";
    initScript.textContent = `window.dataLayer=window.dataLayer||[];window.dataLayer.push({'gtm.start':new Date().getTime(),event:'gtm.js'});`;
    document.head.insertBefore(initScript, script);

    const noscript = document.createElement("noscript");
    noscript.dataset.trackingInjected = "gtm-noscript";
    const iframe = document.createElement("iframe");
    iframe.src = `https://www.googletagmanager.com/ns.html?id=${id}`;
    iframe.height = "0";
    iframe.width = "0";
    iframe.style.display = "none";
    iframe.style.visibility = "hidden";
    noscript.appendChild(iframe);
    document.body.insertBefore(noscript, document.body.firstChild);

    return () => {
      document.querySelectorAll("[data-tracking-injected='gtm'], [data-tracking-injected='gtm-init'], [data-tracking-injected='gtm-noscript']").forEach((el) => el.remove());
    };
  }, [data?.gtmContainerId]);

  useEffect(() => {
    if (!data?.ga4MeasurementId) return;
    const id = data.ga4MeasurementId;

    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
    script.dataset.trackingInjected = "ga4";
    document.head.appendChild(script);

    const initScript = document.createElement("script");
    initScript.dataset.trackingInjected = "ga4-init";
    initScript.textContent = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${id}');`;
    document.head.appendChild(initScript);

    return () => {
      document.querySelectorAll("[data-tracking-injected='ga4'], [data-tracking-injected='ga4-init']").forEach((el) => el.remove());
    };
  }, [data?.ga4MeasurementId]);

  return null;
}
