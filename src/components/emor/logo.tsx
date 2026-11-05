import { cn } from '@/lib/utils';

export function EmorLogo({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={cn('shrink-0', className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="emor-logo-g" x1="8" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#a78bfa" />
          <stop offset="0.55" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#6d28d9" />
        </linearGradient>
        <linearGradient id="emor-logo-g2" x1="20" y1="20" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.75" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" rx="15" fill="url(#emor-logo-g)" />
      <path
        d="M32 14c1.1 0 2 .9 2 2v9.6l7.4-5.7c.9-.7 2.2-.5 2.8.4.7.9.5 2.2-.4 2.8L37.6 28l6.2 4.9c.9.7 1 2 .3 2.8-.7.9-2 1-2.8.3L34 30.2V48c0 1.1-.9 2-2 2s-2-.9-2-2V30.2l-7.3 5.8c-.9.7-2.1.6-2.8-.3-.7-.9-.6-2.1.3-2.8L26.4 28l-6.2-4.9c-.9-.7-1-2-.3-2.8.7-.9 2-1 2.8-.3l7.3 5.7V16c0-1.1.9-2 2-2z"
        fill="url(#emor-logo-g2)"
      />
      <circle cx="32" cy="28" r="3.2" fill="#ffffff" />
    </svg>
  );
}

export function EmorWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-semibold tracking-tight', className)}>
      Emor<span className="text-primary">AI</span>
    </span>
  );
}
