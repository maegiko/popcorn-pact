import AppTabs from '@/components/app-tabs';

/**
 * (tabs) is a pathless group, so the native trigger still resolves `index`
 * and the web href stays `/`. Nesting only creates room in the parent Stack
 * for screens that are not tabs.
 */
export default function TabsLayout() {
  return <AppTabs />;
}
