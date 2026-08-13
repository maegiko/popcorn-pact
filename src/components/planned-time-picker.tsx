import { DateTimePicker } from '@expo/ui/community/datetime-picker';

export type PlannedTimePickerProps = {
  value: Date;
  onChange: (next: Date) => void;
};

/**
 * iOS implementation (also the platform-extension fallback). SwiftUI's
 * `.compact` date-picker style already gives a single field showing both the
 * date and time that opens its own native popover on tap -- exactly the
 * combined calendar+time UX this needs, with no dialog state of our own to
 * manage. Android can't do a combined inline datetime picker (see
 * planned-time-picker.android.tsx), which is why that variant looks
 * different rather than sharing this one.
 */
export function PlannedTimePicker({ value, onChange }: PlannedTimePickerProps) {
  return (
    <DateTimePicker
      value={value}
      mode="datetime"
      display="compact"
      onValueChange={(_event, date) => onChange(date)}
    />
  );
}
