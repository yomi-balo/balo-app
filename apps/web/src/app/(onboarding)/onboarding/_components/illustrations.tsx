'use client';

import { cn } from '@/lib/utils';

interface IllustrationProps {
  className?: string;
}

export function FindExpertIllustration({ className }: IllustrationProps): React.JSX.Element {
  return (
    <div className={cn('relative h-full w-full overflow-hidden', className)}>
      <svg
        viewBox="0 0 400 120"
        className="h-full w-full"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient
            id="find-bg"
            x1="0"
            y1="0"
            x2="400"
            y2="120"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="hsl(var(--primary))" stopOpacity="0.15" />
            <stop offset="1" stopColor="hsl(var(--primary))" stopOpacity="0.03" />
          </linearGradient>
        </defs>

        {/* Background */}
        <rect width="400" height="120" fill="url(#find-bg)" />

        {/* Connection lines */}
        <line
          x1="80"
          y1="40"
          x2="160"
          y2="60"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.2"
          strokeWidth="1"
        />
        <line
          x1="160"
          y1="60"
          x2="240"
          y2="35"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.2"
          strokeWidth="1"
        />
        <line
          x1="160"
          y1="60"
          x2="200"
          y2="90"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.2"
          strokeWidth="1"
        />
        <line
          x1="240"
          y1="35"
          x2="300"
          y2="55"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.2"
          strokeWidth="1"
        />
        <line
          x1="200"
          y1="90"
          x2="300"
          y2="55"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.2"
          strokeWidth="1"
        />
        <line
          x1="80"
          y1="40"
          x2="120"
          y2="85"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.2"
          strokeWidth="1"
        />
        <line
          x1="120"
          y1="85"
          x2="200"
          y2="90"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.2"
          strokeWidth="1"
        />
        <line
          x1="300"
          y1="55"
          x2="350"
          y2="40"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.2"
          strokeWidth="1"
        />

        {/* Network nodes */}
        <circle
          cx="80"
          cy="40"
          r="5"
          fill="hsl(var(--primary))"
          fillOpacity="0.15"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.4"
          strokeWidth="1"
        />
        <circle
          cx="120"
          cy="85"
          r="4"
          fill="hsl(var(--primary))"
          fillOpacity="0.15"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.4"
          strokeWidth="1"
        />
        <circle
          cx="160"
          cy="60"
          r="6"
          fill="hsl(var(--primary))"
          fillOpacity="0.15"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.4"
          strokeWidth="1"
        />
        <circle
          cx="200"
          cy="90"
          r="5"
          fill="hsl(var(--primary))"
          fillOpacity="0.15"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.4"
          strokeWidth="1"
        />
        <circle
          cx="240"
          cy="35"
          r="5"
          fill="hsl(var(--primary))"
          fillOpacity="0.15"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.4"
          strokeWidth="1"
        />
        <circle
          cx="350"
          cy="40"
          r="4"
          fill="hsl(var(--primary))"
          fillOpacity="0.15"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.4"
          strokeWidth="1"
        />

        {/* Highlighted node (the match) */}
        <circle
          cx="300"
          cy="55"
          r="9"
          fill="hsl(var(--primary))"
          fillOpacity="0.25"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.6"
          strokeWidth="1.5"
        />
        <circle cx="300" cy="55" r="4" fill="hsl(var(--primary))" fillOpacity="0.8" />

        {/* Magnifying glass */}
        <circle
          cx="310"
          cy="48"
          r="14"
          fill="none"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.3"
          strokeWidth="1.5"
        />
        <line
          x1="320"
          y1="58"
          x2="332"
          y2="70"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.3"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

export function BecomeExpertIllustration({ className }: IllustrationProps): React.JSX.Element {
  return (
    <div className={cn('relative h-full w-full overflow-hidden', className)}>
      <svg
        viewBox="0 0 400 120"
        className="h-full w-full"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient
            id="expert-bg"
            x1="0"
            y1="0"
            x2="400"
            y2="120"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="rgb(139, 92, 246)" stopOpacity="0.15" />
            <stop offset="1" stopColor="hsl(var(--primary))" stopOpacity="0.03" />
          </linearGradient>
        </defs>

        {/* Background */}
        <rect width="400" height="120" fill="url(#expert-bg)" />

        {/* Subtle grid lines */}
        <line
          x1="60"
          y1="0"
          x2="60"
          y2="120"
          stroke="rgb(139, 92, 246)"
          strokeOpacity="0.06"
          strokeWidth="1"
        />
        <line
          x1="140"
          y1="0"
          x2="140"
          y2="120"
          stroke="rgb(139, 92, 246)"
          strokeOpacity="0.06"
          strokeWidth="1"
        />
        <line
          x1="220"
          y1="0"
          x2="220"
          y2="120"
          stroke="rgb(139, 92, 246)"
          strokeOpacity="0.06"
          strokeWidth="1"
        />
        <line
          x1="300"
          y1="0"
          x2="300"
          y2="120"
          stroke="rgb(139, 92, 246)"
          strokeOpacity="0.06"
          strokeWidth="1"
        />
        <line
          x1="0"
          y1="30"
          x2="400"
          y2="30"
          stroke="rgb(139, 92, 246)"
          strokeOpacity="0.06"
          strokeWidth="1"
        />
        <line
          x1="0"
          y1="60"
          x2="400"
          y2="60"
          stroke="rgb(139, 92, 246)"
          strokeOpacity="0.06"
          strokeWidth="1"
        />
        <line
          x1="0"
          y1="90"
          x2="400"
          y2="90"
          stroke="rgb(139, 92, 246)"
          strokeOpacity="0.06"
          strokeWidth="1"
        />

        {/* Ascending curved path */}
        <path
          d="M 60 100 Q 140 85 180 70 Q 220 55 260 45 Q 300 35 340 25"
          stroke="rgb(139, 92, 246)"
          strokeOpacity="0.4"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
        />

        {/* Milestone dots along the path */}
        <circle
          cx="100"
          cy="90"
          r="4"
          fill="rgb(139, 92, 246)"
          fillOpacity="0.2"
          stroke="rgb(139, 92, 246)"
          strokeOpacity="0.4"
          strokeWidth="1"
        />
        <circle
          cx="180"
          cy="70"
          r="4"
          fill="rgb(139, 92, 246)"
          fillOpacity="0.2"
          stroke="rgb(139, 92, 246)"
          strokeOpacity="0.4"
          strokeWidth="1"
        />
        <circle
          cx="260"
          cy="45"
          r="5"
          fill="rgb(139, 92, 246)"
          fillOpacity="0.3"
          stroke="rgb(139, 92, 246)"
          strokeOpacity="0.5"
          strokeWidth="1"
        />

        {/* Badge/star at the top */}
        <circle
          cx="340"
          cy="25"
          r="12"
          fill="rgb(139, 92, 246)"
          fillOpacity="0.15"
          stroke="rgb(139, 92, 246)"
          strokeOpacity="0.5"
          strokeWidth="1.5"
        />
        {/* Star shape inside badge */}
        <path
          d="M 340 17 L 342 22 L 347 22 L 343 25.5 L 344.5 30.5 L 340 27.5 L 335.5 30.5 L 337 25.5 L 333 22 L 338 22 Z"
          fill="rgb(139, 92, 246)"
          fillOpacity="0.6"
        />
      </svg>
    </div>
  );
}
