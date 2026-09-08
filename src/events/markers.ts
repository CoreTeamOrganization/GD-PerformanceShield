/**
 * Step 7 - the operator's event vocabulary.
 *
 * The human labels game state; the tool measures everything else. Markers are a
 * closed, stable set (plus a free-text custom marker) because the analysis
 * stages key off them: `baseline`, `gameplay_start` and `gameplay_end` in
 * particular define the recovery-delta computation in spec section 9.
 */

export interface MarkerDefinition {
  /** Machine name written into the event log. */
  type: string;
  label: string;
  /** Grouping used to lay out the operator UI. */
  group: 'flow' | 'screen' | 'control';
  /** Keyboard accelerator in the operator UI. */
  hotkey?: string;
  description: string;
  /** Analysis meaning, if any. */
  semantics?: 'baseline' | 'flow_start' | 'flow_end' | 'screen_open' | 'screen_close' | 'flow_complete';
}

export const MARKERS: MarkerDefinition[] = [
  {
    type: 'baseline',
    label: 'Baseline',
    group: 'control',
    hotkey: 'b',
    description: 'Memory is stable at a known reference state. Every recovery delta is measured against the most recent baseline.',
    semantics: 'baseline',
  },
  {
    type: 'main_menu',
    label: 'Main Menu',
    group: 'screen',
    hotkey: '1',
    description: 'The main menu is fully loaded and idle.',
    semantics: 'screen_open',
  },
  {
    type: 'gameplay_start',
    label: 'Gameplay Start',
    group: 'flow',
    hotkey: 'g',
    description: 'Actual gameplay has begun (level loaded, control handed to the player).',
    semantics: 'flow_start',
  },
  {
    type: 'gameplay_end',
    label: 'Gameplay End',
    group: 'flow',
    hotkey: 'h',
    description: 'Gameplay has finished and the game is returning to the menu.',
    semantics: 'flow_end',
  },
  {
    type: 'shop',
    label: 'Shop',
    group: 'screen',
    hotkey: '2',
    description: 'The shop screen is open.',
    semantics: 'screen_open',
  },
  {
    type: 'inventory',
    label: 'Inventory',
    group: 'screen',
    hotkey: '3',
    description: 'The inventory or customization screen is open.',
    semantics: 'screen_open',
  },
  {
    type: 'settings',
    label: 'Settings',
    group: 'screen',
    hotkey: '4',
    description: 'The settings screen is open.',
    semantics: 'screen_open',
  },
  {
    type: 'screen_close',
    label: 'Close Screen',
    group: 'screen',
    hotkey: 'c',
    description: 'The most recently opened screen has been closed. Pairs with the open marker to measure whether its memory was released.',
    semantics: 'screen_close',
  },
  {
    type: 'flow_complete',
    label: 'Flow Complete',
    group: 'control',
    hotkey: 'f',
    description: 'One full test cycle is finished. Ends the current repeat and starts the next.',
    semantics: 'flow_complete',
  },
  {
    type: 'custom',
    label: 'Custom Event',
    group: 'control',
    hotkey: 'x',
    description: 'Any other state worth marking. Free-text label.',
  },
];

export const MARKER_TYPES = new Set(MARKERS.map((m) => m.type));

export function findMarker(type: string): MarkerDefinition | undefined {
  return MARKERS.find((m) => m.type === type);
}

export function markerLabel(type: string, custom?: string): string {
  if (type === 'custom' && custom) return custom;
  return findMarker(type)?.label ?? type;
}
