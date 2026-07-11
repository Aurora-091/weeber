type WeeberLogoProps = {
  className?: string;
  size?: "sm" | "md" | "lg";
  variant?: "wordmark" | "icon";
  inverted?: boolean;
};

const HEIGHT_MAP = {
  sm: 24,
  md: 31,
  lg: 44,
};

const ICON_HEIGHT_MAP = {
  sm: 31,
  md: 40,
  lg: 57,
};

/** Weeber wordmark/icon — real brand assets, ported from Vocalist
 * (github.com/Aurora-091/Vocalist's src/components/WeeberLogo.tsx). */
export function WeeberLogo({ className = "", size = "md", variant = "wordmark", inverted = false }: WeeberLogoProps) {
  const h = variant === "icon" ? ICON_HEIGHT_MAP[size] : HEIGHT_MAP[size];
  const src = variant === "icon" ? "/weeber_favicon_transparent.png" : "/weeber_logo_transparent.png";

  const style: React.CSSProperties = {
    display: "inline-block",
    verticalAlign: "middle",
    height: h,
    width: "auto",
    ...(inverted ? { filter: "brightness(0) invert(1)" } : {}),
  };

  return (
    <img
      src={src}
      alt="Weeber"
      width={variant === "icon" ? h : Math.round(h * 3.5)}
      height={h}
      style={style}
      className={`${inverted ? "" : "dark:invert"} ${className}`}
    />
  );
}
