import { useTheme } from '@/hooks/use-theme';

export type PlannedTimePickerProps = {
  value: Date;
  onChange: (next: Date) => void;
};

/** `<input type="datetime-local">` takes and returns local time with no timezone suffix. */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * @expo/ui's community DateTimePicker renders nothing on web (there is no
 * SwiftUI/Jetpack Compose host there), and this app is mobile-first rather
 * than web-first -- so the web fallback is the simplest thing that still
 * lets both date and time be chosen: the browser's own native
 * `datetime-local` control, with no extra dependency.
 */
export function PlannedTimePicker({ value, onChange }: PlannedTimePickerProps) {
  const theme = useTheme();

  return (
    <input
      type="datetime-local"
      value={toLocalInputValue(value)}
      onChange={(event) => {
        const next = new Date(event.target.value);
        if (!Number.isNaN(next.getTime())) onChange(next);
      }}
      style={{
        borderRadius: 8,
        border: 'none',
        padding: '10px 12px',
        fontSize: 16,
        backgroundColor: theme.backgroundElement,
        color: theme.text,
      }}
    />
  );
}
