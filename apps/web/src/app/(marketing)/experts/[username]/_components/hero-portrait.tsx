/**
 * Illustrated portrait placeholder shown when the expert has no headshot
 * (or the CDN env is unset). Purely decorative — the real photo swaps straight
 * in via the Next `Image` in `Hero`.
 */
export function HeroPortrait(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 280 336"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      className="block h-full w-full"
    >
      <defs>
        <linearGradient id="hp-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F6E7D6" />
          <stop offset="100%" stopColor="#E7CDB3" />
        </linearGradient>
        <linearGradient id="hp-shirt" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#36313C" />
          <stop offset="100%" stopColor="#221F2A" />
        </linearGradient>
      </defs>
      <rect width="280" height="336" fill="url(#hp-bg)" />
      <path d="M40 336 C46 264 92 246 140 246 C188 246 234 264 240 336 Z" fill="url(#hp-shirt)" />
      <rect x="120" y="242" width="40" height="26" fill="#C99A78" />
      <rect x="124" y="228" width="32" height="28" rx="14" fill="#C99A78" />
      <ellipse cx="140" cy="166" rx="56" ry="62" fill="#D7A982" />
      <path
        d="M84 164 C82 116 104 96 140 96 C176 96 198 116 196 164 C196 146 178 134 140 134 C102 134 84 146 84 164 Z"
        fill="#2B221C"
      />
      <path d="M84 168 C80 146 88 128 100 122 C92 140 92 156 92 168 Z" fill="#2B221C" />
      <g stroke="#2B221C" strokeWidth="3" fill="none">
        <rect x="106" y="158" width="26" height="20" rx="7" />
        <rect x="148" y="158" width="26" height="20" rx="7" />
        <path d="M132 166 H148" />
        <path d="M106 164 L96 162 M174 164 L184 162" />
      </g>
      <path
        d="M126 196 Q140 208 154 196"
        stroke="#9E6B49"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
