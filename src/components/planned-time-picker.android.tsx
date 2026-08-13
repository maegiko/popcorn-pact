import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

export type PlannedTimePickerProps = {
  value: Date;
  onChange: (next: Date) => void;
};

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const timeFormatter = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

function withDate(base: Date, datePart: Date): Date {
  const next = new Date(base);
  next.setFullYear(datePart.getFullYear(), datePart.getMonth(), datePart.getDate());
  return next;
}

function withTime(base: Date, timePart: Date): Date {
  const next = new Date(base);
  next.setHours(timePart.getHours(), timePart.getMinutes(), 0, 0);
  return next;
}

/**
 * Android has no inline combined date+time picker (@expo/ui's own Jetpack
 * Compose wrapper falls back to date-only for `mode="datetime"`), so this
 * exposes the date and time as two fields that each open the native
 * Material dialog picker on tap. Every dialog is unmounted immediately after
 * it reports a selection or a dismissal -- `presentation="dialog"` opens as
 * soon as the component mounts, so leaving it mounted would reopen it.
 */
export function PlannedTimePicker({ value, onChange }: PlannedTimePickerProps) {
  const [open, setOpen] = useState<'date' | 'time' | null>(null);

  return (
    <View style={styles.row}>
      <Pressable onPress={() => setOpen('date')} style={styles.fieldPressable}>
        <ThemedView type="backgroundElement" style={styles.field}>
          <ThemedText type="small" themeColor="textSecondary">
            Date
          </ThemedText>
          <ThemedText type="default">{dateFormatter.format(value)}</ThemedText>
        </ThemedView>
      </Pressable>

      <Pressable onPress={() => setOpen('time')} style={styles.fieldPressable}>
        <ThemedView type="backgroundElement" style={styles.field}>
          <ThemedText type="small" themeColor="textSecondary">
            Time
          </ThemedText>
          <ThemedText type="default">{timeFormatter.format(value)}</ThemedText>
        </ThemedView>
      </Pressable>

      {open === 'date' && (
        <DateTimePicker
          value={value}
          mode="date"
          onValueChange={(_event, date) => {
            onChange(withDate(value, date));
            setOpen(null);
          }}
          onDismiss={() => setOpen(null)}
        />
      )}

      {open === 'time' && (
        <DateTimePicker
          value={value}
          mode="time"
          onValueChange={(_event, date) => {
            onChange(withTime(value, date));
            setOpen(null);
          }}
          onDismiss={() => setOpen(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  fieldPressable: {
    flex: 1,
  },
  field: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    gap: Spacing.one,
  },
});
