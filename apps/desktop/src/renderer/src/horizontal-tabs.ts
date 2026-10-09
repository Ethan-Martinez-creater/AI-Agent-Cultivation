import type { KeyboardEvent } from 'react';

export function horizontalTabIndex(activeTab: string, tab: string): 0 | -1 {
  return activeTab === tab ? 0 : -1;
}

export function horizontalTabDestinationIndex(
  key: string,
  currentIndex: number,
  tabCount: number,
): number | null {
  if (tabCount < 1 || currentIndex < 0 || currentIndex >= tabCount) return null;

  switch (key) {
    case 'ArrowRight':
      return (currentIndex + 1) % tabCount;
    case 'ArrowLeft':
      return (currentIndex - 1 + tabCount) % tabCount;
    case 'Home':
      return 0;
    case 'End':
      return tabCount - 1;
    default:
      return null;
  }
}

export function handleHorizontalTabKeyDown<T extends string>(
  event: Pick<KeyboardEvent<HTMLButtonElement>, 'key' | 'currentTarget' | 'preventDefault'>,
  tabs: readonly T[],
  currentTab: T,
  selectTab: (tab: T) => void,
): void {
  const currentIndex = tabs.indexOf(currentTab);
  const nextIndex = horizontalTabDestinationIndex(event.key, currentIndex, tabs.length);
  if (nextIndex === null) return;

  const tablist = event.currentTarget.closest('[role="tablist"]');
  const nextButton = tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex];
  const nextTab = tabs[nextIndex];
  if (!nextButton || nextTab === undefined) return;

  event.preventDefault();
  selectTab(nextTab);
  nextButton.focus();
}
