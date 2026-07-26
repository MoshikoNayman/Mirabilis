import { test, expect } from '@playwright/test';

// The tab is labelled "Ledger" and the view heading is "IntelLedger". This spec
// previously looked for a title="InteLedger" that the app has not rendered for a
// long time; because nothing ever ran the spec, the rot went unnoticed.
async function openIntelLedger(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Ledger', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'IntelLedger', exact: true })).toBeVisible();
}

async function createSession(page, title) {
  await page.getByRole('button', { name: 'New Session', exact: true }).click();
  await page.getByPlaceholder('Leave blank for Untitled').fill(title);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
}

test('create and delete one session without deleting others after refresh', async ({ page }) => {
  const unique = Date.now();
  const keepTitle = `e2e-keep-${unique}`;
  const deleteTitle = `e2e-delete-${unique}`;

  await openIntelLedger(page);
  await createSession(page, keepTitle);
  await createSession(page, deleteTitle);

  // Select by test id, not by CSS class: the previous XPath keyed on
  // `rounded-2xl`, which became `rounded-[var(--r-lg)]` and silently stopped
  // matching anything.
  const deleteCard = page.getByTestId('session-card').filter({ hasText: deleteTitle });

  await expect(deleteCard).toBeVisible();
  await deleteCard.getByRole('button', { name: 'Delete', exact: true }).click();

  await expect(page.getByRole('button', { name: deleteTitle, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: keepTitle, exact: true })).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Ledger', exact: true }).click();

  await expect(page.getByRole('button', { name: keepTitle, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: deleteTitle, exact: true })).toHaveCount(0);
});
