// KoduDB mark: "koodu" is a nest; three stacked rings read as a nest and as a database at once.
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none">
      <rect width="24" height="24" rx="6" fill="var(--accent-9)" />
      <ellipse cx="12" cy="7.6" rx="6.2" ry="2.3" stroke="#fff" strokeWidth="1.7" />
      <path d="M5.8 11.6c0 1.3 2.8 2.3 6.2 2.3s6.2-1 6.2-2.3" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M5.8 15.6c0 1.3 2.8 2.3 6.2 2.3s6.2-1 6.2-2.3" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" opacity=".75" />
    </svg>
  )
}
