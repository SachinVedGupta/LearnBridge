import type { SVGProps } from 'react';

export default function AssignmentLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 640 180" role="img" aria-label="Assignment AI wordmark" {...props}>
      <defs>
        <linearGradient id="acc" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--aa-accent, #7c3aed)" />
          <stop offset="1" stopColor="var(--aa-accent-2, #06b6d4)" />
        </linearGradient>
        <style>{`
          .ink{fill:var(--aa-ink, #0b0f1a);}
          @media (prefers-color-scheme: dark){
            .ink{fill:#e6eaf2;}
          }
        `}</style>
      </defs>

      <g transform="translate(6,6) scale(1.25)">
        <rect x="0" y="0" width="120" height="120" rx="24" fill="none" stroke="url(#acc)" strokeWidth="6" />
        <rect x="36" y="24" width="6" height="72" rx="3" fill="url(#acc)" />
        <rect x="50" y="24" width="48" height="6" rx="3" fill="url(#acc)" opacity=".7" />
        <rect x="50" y="42" width="40" height="6" rx="3" fill="url(#acc)" opacity=".5" />
        <rect x="50" y="60" width="34" height="6" rx="3" fill="url(#acc)" opacity=".35" />
        <circle cx="92" cy="28" r="7" fill="url(#acc)" />
      </g>

      <g className="ink" transform="translate(170,38)">
        <text x="0" y="54" fontFamily="Inter, ui-sans-serif, system-ui" fontWeight="700" fontSize="56">
          Assignment AI
        </text>
        <text
          x="2"
          y="94"
          fontFamily="Inter, ui-sans-serif, system-ui"
          fontWeight="400"
          fontSize="24"
          opacity=".65"
        >
          AI-powered text editor
        </text>
      </g>
    </svg>
  );
}
