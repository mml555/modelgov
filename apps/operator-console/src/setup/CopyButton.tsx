import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * Small "copy to clipboard" button for the setup wizard — used next to the
 * terminal commands the wizard shows (e.g. `make start-cloud`) so a
 * non-technical operator can copy the exact command in one click instead of
 * hand-typing it.
 *
 * Self-contained (no external CSS required): pass a `className` to restyle, or
 * use the default inline styling. Falls back to a hidden-textarea copy when the
 * async Clipboard API is unavailable (e.g. plain-http remote, older browsers).
 */
export function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied!",
  className,
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Clear a pending "Copied!" reset if the component unmounts mid-timeout.
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const onCopy = useCallback(async () => {
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }, [text]);

  return (
    <button
      type="button"
      className={className}
      onClick={() => void onCopy()}
      aria-label={copied ? copiedLabel : `${label} to clipboard`}
      style={className ? undefined : DEFAULT_STYLE}
    >
      <span aria-live="polite">{copied ? copiedLabel : label}</span>
    </button>
  );
}

const DEFAULT_STYLE: CSSProperties = {
  cursor: "pointer",
  border: "1px solid currentColor",
  borderRadius: 6,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontSize: "0.85em",
  padding: "0.25em 0.7em",
  lineHeight: 1.4,
};

/** Copy `text`, preferring the async Clipboard API with a legacy fallback. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path (e.g. non-secure context).
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
