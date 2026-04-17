interface Props<T extends string> {
  label: string;
  col: T;
  sortBy: T;
  sortDir: 'asc' | 'desc';
  onChange: (col: T, dir: 'asc' | 'desc') => void;
  align?: 'left' | 'right';
}

export default function SortHeader<T extends string>({ label, col, sortBy, sortDir, onChange, align = 'left' }: Props<T>) {
  const active = sortBy === col;
  function click() {
    if (active) onChange(col, sortDir === 'asc' ? 'desc' : 'asc');
    else onChange(col, 'asc');
  }
  return (
    <button
      onClick={click}
      className={`text-left text-xs uppercase tracking-wide ${active ? 'text-text-primary' : 'text-text-muted'} hover:text-text-primary ${align === 'right' ? 'text-right w-full' : ''}`}
    >
      {label}{active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </button>
  );
}
