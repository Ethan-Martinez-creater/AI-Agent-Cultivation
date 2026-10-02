import type { ComponentProps } from 'react';
import { Drawer } from './Drawer.js';

/** Shared native-modal behavior for compact confirmation and editing flows. */
export function Dialog(props: Omit<ComponentProps<typeof Drawer>, 'variant'>) {
  return <Drawer {...props} variant="dialog" />;
}
