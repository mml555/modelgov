import { useState } from "react";

const MONOGRAM_FALLBACK: Record<string, { letter: string; color: string }> = {
  openrouter: { letter: "OR", color: "#6366F1" },
  mistral: { letter: "M", color: "#F7D046" },
  groq: { letter: "G", color: "#F55036" },
  deepseek: { letter: "D", color: "#4D6BFE" },
  cohere: { letter: "C", color: "#39594D" },
};

const COLORED_LOGOS = new Set(["openrouter", "mistral", "groq", "deepseek", "cohere"]);

interface ProviderLogoProps {
  slug: string;
  label: string;
  size?: number;
  className?: string;
}

export function ProviderLogo({ slug, label, size = 20, className = "" }: ProviderLogoProps) {
  const [failed, setFailed] = useState(false);
  const fallback = MONOGRAM_FALLBACK[slug];

  if (failed && fallback) {
    return (
      <span
        className={`setup-provider-logo-fallback ${className}`.trim()}
        style={{ background: fallback.color, width: size, height: size, fontSize: size * 0.38 }}
        aria-hidden
      >
        {fallback.letter}
      </span>
    );
  }

  return (
    <img
      src={`/providers/${slug}.svg`}
      alt=""
      width={size}
      height={size}
      className={`setup-provider-logo${COLORED_LOGOS.has(slug) ? "" : " setup-provider-logo--mono"} ${className}`.trim()}
      onError={() => setFailed(true)}
      title={label}
    />
  );
}
