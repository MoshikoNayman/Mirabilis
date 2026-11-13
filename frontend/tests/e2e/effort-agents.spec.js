import { test, expect } from '@playwright/test';

// UI only: CI has no model engine, so nothing is sent. A fresh backend starts at
// Chat only, where Ultra keeps its Agents control and 1 hour has none.

const chip = (page) => page.getByRole('button', { name: /^Effort:/ });
// Scoped to the menu: the model picker can list a model with Ultra in its name.
const effortMenu = (page) => page.getByRole('group', { name: 'Effort', exact: true });
const agentsGroup = (page) => page.getByRole('group', { name: 'Agents', exact: true });

async function pickEffort(page, label) {
  await chip(page).click();
  await effortMenu(page).getByRole('button', { name: label, exact: true }).click();
}

test('the Effort menu sets the agent count, the chip shows it and a reload keeps it', async ({ page }) => {
  await page.goto('/');
  await expect(chip(page)).toBeVisible();

  await pickEffort(page, 'Ultra');
  await expect(chip(page)).toHaveText('Effort: Ultra, 4 agents');

  await chip(page).click();
  const agents = agentsGroup(page);
  await expect(agents.locator('output')).toHaveText('4 agents');
  await agents.getByRole('button', { name: 'More agents', exact: true }).click();
  await expect(agents.locator('output')).toHaveText('5 agents');
  // A stepper press keeps the menu open; the chip takes the new count when it closes.
  await expect(agents).toBeVisible();
  await expect(chip(page)).toHaveText('Effort: Ultra, 4 agents');
  await page.keyboard.press('Escape');
  await expect(chip(page)).toHaveText('Effort: Ultra, 5 agents');

  await page.reload();
  await expect(chip(page)).toHaveText('Effort: Ultra, 5 agents');

  await expect(page.getByRole('button', { name: 'Access: Chat only', exact: true })).toBeVisible();
  await pickEffort(page, '1 hour');
  await expect(chip(page)).toHaveText('Effort: 1 hour');
  await chip(page).click();
  await expect(effortMenu(page)).toBeVisible();
  await expect(agentsGroup(page)).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(chip(page)).toBeFocused();
});

test('stepper presses leave the chip and the menu where they are', async ({ page }) => {
  await page.goto('/');
  await pickEffort(page, 'Ultra');
  await chip(page).click();
  const agents = agentsGroup(page);
  const more = agents.getByRole('button', { name: 'More agents', exact: true });
  // From one agent the count suffix appears, the widest change the chip can make.
  await agents.getByRole('button', { name: 'Fewer agents', exact: true }).focus();
  await page.keyboard.press('Home');
  await expect(agents.locator('output')).toHaveText('1 agent');
  const chipBox = await chip(page).boundingBox();
  const moreBox = await more.boundingBox();
  await more.click();
  await more.click();
  await expect(agents.locator('output')).toHaveText('3 agents');
  expect(await chip(page).boundingBox()).toEqual(chipBox);
  expect(await more.boundingBox()).toEqual(moreBox);
  await page.keyboard.press('Escape');
  await expect(chip(page)).toHaveText('Effort: Ultra, 3 agents');
});

test('the effort rows sit inside the scrolling list, so a focus ring shows whole', async ({ page }) => {
  await page.goto('/');
  await chip(page).click();
  const row = effortMenu(page).getByRole('button', { name: 'Ultra', exact: true });
  // The list clips at its own edge and the ring is 3px wide.
  const inset = await row.evaluate((el) => {
    const list = el.closest('.au-scroll');
    const a = el.getBoundingClientRect();
    const b = list.getBoundingClientRect();
    return Math.min(a.left - b.left, b.right - a.right);
  });
  expect(inset).toBeGreaterThanOrEqual(3);
});

test('on a narrow screen the chip hides its prefix and stays on one line', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/');
  await pickEffort(page, 'Ultra');
  // Hidden from view only: the prefix stays in the name.
  await expect(chip(page)).toHaveAccessibleName('Effort: Ultra, 4 agents');
  const fit = await chip(page).evaluate((el) => {
    const group = el.parentElement.parentElement;
    return {
      nowrap: getComputedStyle(el).whiteSpace === 'nowrap',
      oneLine: el.scrollHeight <= el.clientHeight,
      inside: el.getBoundingClientRect().right <= group.getBoundingClientRect().right + 0.5
    };
  });
  expect(fit).toEqual({ nowrap: true, oneLine: true, inside: true });
});
