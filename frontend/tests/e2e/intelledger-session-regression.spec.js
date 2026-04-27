import { test, expect } from '@playwright/test';

async function openIntelLedger(page) {
  await page.goto('/');
  await page.getByTitle('InteLedger').click();
  await expect(page.getByRole('heading', { name: 'InteLedger' })).toBeVisible();
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

  const deleteCard = page
    .getByRole('button', { name: deleteTitle, exact: true })
    .locator('xpath=ancestor::div[contains(@class,"group") and contains(@class,"rounded-2xl")][1]');

  await expect(deleteCard).toBeVisible();
  await deleteCard.getByRole('button', { name: 'Delete', exact: true }).click();

  await expect(page.getByRole('button', { name: deleteTitle, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: keepTitle, exact: true })).toBeVisible();

  await page.reload();
  await page.getByTitle('InteLedger').click();

  await expect(page.getByRole('button', { name: keepTitle, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: deleteTitle, exact: true })).toHaveCount(0);
});
