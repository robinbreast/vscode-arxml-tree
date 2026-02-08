import { createCddViewBehavior } from './cddViewBehavior';
import { ViewBehavior } from './viewBehavior';

export function createDefaultViewBehaviors(): ViewBehavior[] {
  return [
    createCddViewBehavior()
  ];
}
