import AppTabs from '@/components/app-tabs';

/**
 * (tabs) is a pathless group, so the native triggers still resolve `index` and
 * `explore` and the web hrefs stay `/` and `/explore`. Nesting only creates
 * room in the parent Stack for screens that are not tabs.
 */
export default function TabsLayout() {
  return <AppTabs />;
}
