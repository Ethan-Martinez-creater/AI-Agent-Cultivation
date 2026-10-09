import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { KeyboardEvent } from 'react';
import { MissionPage } from './pages/missions.js';
import { WorkflowsPage } from './pages/workflows.js';
import {
  handleHorizontalTabKeyDown,
  horizontalTabDestinationIndex,
  horizontalTabIndex,
} from './horizontal-tabs.js';

const tabs = ['running', 'history', 'all'] as const;

function fakeTabEvent(key: string, count: number) {
  const focused: number[] = [];
  const buttons = Array.from({ length: count }, (_, index) => ({
    focus: () => focused.push(index),
  }));
  const preventDefault = vi.fn();
  const currentTarget = {
    closest: vi.fn(() => ({ querySelectorAll: () => buttons })),
  };
  return {
    event: { key, preventDefault, currentTarget } as unknown as Pick<
      KeyboardEvent<HTMLButtonElement>,
      'key' | 'currentTarget' | 'preventDefault'
    >,
    buttons,
    focused,
    preventDefault,
  };
}

function tabAttributes(markup: string): string[] {
  return [...markup.matchAll(/<button\b([^>]*)>/g)]
    .map((match) => match[1] ?? '')
    .filter((attributes) => attributes.includes('role="tab"'));
}

describe('horizontal tab keyboard navigation', () => {
  it.each([
    ['ArrowRight', 0, 1],
    ['ArrowRight', 2, 0],
    ['ArrowLeft', 0, 2],
    ['ArrowLeft', 2, 1],
    ['Home', 2, 0],
    ['End', 0, 2],
  ])('%s moves from index %i to index %i', (key, current, expected) => {
    expect(horizontalTabDestinationIndex(key, current, tabs.length)).toBe(expected);
  });

  it('ignores unrelated keys and invalid indices', () => {
    expect(horizontalTabDestinationIndex('ArrowDown', 0, tabs.length)).toBeNull();
    expect(horizontalTabDestinationIndex('ArrowRight', -1, tabs.length)).toBeNull();
    expect(horizontalTabDestinationIndex('ArrowRight', 0, 0)).toBeNull();
  });

  it('selects the destination, prevents browser scrolling, and moves focus', () => {
    const fixture = fakeTabEvent('ArrowRight', tabs.length);
    const selectTab = vi.fn();

    handleHorizontalTabKeyDown(fixture.event, tabs, 'running', selectTab);

    expect(fixture.preventDefault).toHaveBeenCalledOnce();
    expect(selectTab).toHaveBeenCalledWith('history');
    expect(fixture.focused).toEqual([1]);
  });

  it('does nothing for keys outside the horizontal tab pattern', () => {
    const fixture = fakeTabEvent('ArrowDown', tabs.length);
    const selectTab = vi.fn();

    handleHorizontalTabKeyDown(fixture.event, tabs, 'running', selectTab);

    expect(fixture.preventDefault).not.toHaveBeenCalled();
    expect(selectTab).not.toHaveBeenCalled();
    expect(fixture.focused).toEqual([]);
  });

  it('keeps only the selected tab in the tab order', () => {
    expect(tabs.map((tab) => horizontalTabIndex('history', tab))).toEqual([-1, 0, -1]);
  });
});

describe('Mission and Workflow tab wiring', () => {
  it('renders a single tab stop for each page tablist', () => {
    const missionMarkup = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(MissionPage)),
    );
    const workflowMarkup = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(WorkflowsPage)),
    );

    expect(
      tabAttributes(missionMarkup).map((attributes) => attributes.match(/tabindex="(-?\d+)"/)?.[1]),
    ).toEqual(['0', '-1', '-1']);
    expect(
      tabAttributes(workflowMarkup).map(
        (attributes) => attributes.match(/tabindex="(-?\d+)"/)?.[1],
      ),
    ).toEqual(['0', '-1', '-1']);
  });
});
