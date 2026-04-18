/**
 * Shared loading indicator for async list fetches (Radio, Last.fm, etc.).
 * Renders a subtle message + an animated indeterminate progress bar
 * (CSS-keyframed shimmer) so the user knows a network call is in flight.
 *
 * Not to be confused with ScanProgressPanel (which has real percent
 * progress) — this is purely indeterminate.
 */
interface Props {
  label?: string;
  accent?: 'accent' | 'red' | 'blue';
  className?: string;
}

export default function LoadingStrip({ label = 'Loading…', accent = 'accent', className }: Props) {
  const barColor = accent === 'red' ? 'bg-red-400' : accent === 'blue' ? 'bg-blue-400' : 'bg-accent';
  const spinnerColor = accent === 'red' ? 'border-red-400' : accent === 'blue' ? 'border-blue-400' : 'border-accent';
  return (
    <div className={`flex items-center gap-3 text-sm ${className ?? ''}`}>
      <div className={`w-4 h-4 border-2 ${spinnerColor} border-t-transparent rounded-full animate-spin flex-shrink-0`} />
      <span className="text-text-muted">{label}</span>
      <div className="relative flex-1 h-1 bg-white/5 rounded overflow-hidden max-w-xs">
        {/* Indeterminate bar — a 30%-wide slider that loops across. */}
        <div className={`absolute top-0 h-full w-[30%] rounded ${barColor} loading-indeterminate`} />
      </div>
    </div>
  );
}
