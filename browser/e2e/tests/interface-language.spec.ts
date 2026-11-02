import { test, expect, type Page } from './fixtures';
import {
  before,
  currentDriveTitle,
  FRONTEND_URL,
  newDrive,
} from './test-utils';

const english = {
  user: 'User',
  drives: 'My drives',
  name: 'Your name',
  profile: 'More profile fields',
  signOut: 'Sign out',
  privateDrive: 'Private drive',
  appearance: 'Appearance',
  switchDrive: 'Switch Drive',
};

type AccountLabels = typeof english;

const languages: Array<{ locale: string; labels: AccountLabels }> = [
  {
    locale: 'es',
    labels: {
      user: 'Usuario',
      drives: 'Mis unidades',
      name: 'Tu nombre',
      profile: 'Más campos del perfil',
      signOut: 'Cerrar sesión',
      privateDrive: 'Unidad privada',
      appearance: 'Apariencia',
      switchDrive: 'Cambiar de unidad',
    },
  },
  {
    locale: 'fr',
    labels: {
      user: 'Utilisateur',
      drives: 'Mes lecteurs',
      name: 'Votre nom',
      profile: 'Plus de champs de profil',
      signOut: 'Se déconnecter',
      privateDrive: 'Lecteur privé',
      appearance: 'Apparence',
      switchDrive: 'Changer de lecteur',
    },
  },
  {
    locale: 'de',
    labels: {
      user: 'Benutzer',
      drives: 'Meine Laufwerke',
      name: 'Dein Name',
      profile: 'Weitere Profilfelder',
      signOut: 'Abmelden',
      privateDrive: 'Privates Laufwerk',
      appearance: 'Darstellung',
      switchDrive: 'Laufwerk wechseln',
    },
  },
];

async function expectAccount(
  page: Page,
  labels: AccountLabels,
  driveTitle: string,
) {
  await expect(
    page.getByRole('heading', { level: 1, name: labels.user, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: labels.drives, exact: true }),
  ).toBeVisible();
  await expect(page.locator('#boot-splash')).toBeHidden();
  await expect(
    page.getByRole('textbox', { name: labels.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: labels.profile, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: labels.signOut, exact: true }),
  ).toBeVisible();
  // User-authored resource names must remain data, not become UI translations.
  await expect(currentDriveTitle(page)).toHaveText(driveTitle);
  await expect(
    page.getByTestId('my-drives').getByText(driveTitle, { exact: true }),
  ).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/\[i18n-404:/);
}

async function expectDriveMenu(
  page: Page,
  labels: AccountLabels,
  driveTitle: string,
) {
  await page
    .getByTestId('sidebar')
    .getByTitle(labels.switchDrive, { exact: true })
    .click();
  const menu = page.getByRole('menu');
  await expect(
    menu.getByText(labels.privateDrive, { exact: true }),
  ).toBeVisible();
  await expect(menu.getByText(driveTitle, { exact: true })).toBeVisible();
  await expect(menu).not.toContainText(/\[i18n-404:/);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
}

test.describe('interface language', () => {
  test.use({ locale: 'en-GB' });
  test.beforeEach(before);

  for (const { locale, labels } of languages) {
    test(`${locale}: account and drive menu translate, persist and switch back`, async ({
      page,
    }, testInfo) => {
      const { driveTitle } = await newDrive(page);
      await page.goto(`${FRONTEND_URL}/app/agent`);
      await expectAccount(page, english, driveTitle);
      await expectDriveMenu(page, english, driveTitle);

      // Exercise the real Settings control, without writing locale storage or
      // calling the translation runtime from the test.
      await page.getByTestId('sidebar-settings-button').click();
      await page.getByText(english.appearance, { exact: true }).click();
      const language = page.locator('#settings-language');
      await expect(language).toHaveValue('en');
      await language.selectOption(locale);
      // Loading a locale remounts Settings with its sections collapsed.
      // Reopen Appearance only once its translated label has arrived.
      await page.getByText(labels.appearance, { exact: true }).click();
      await expect(language).toHaveValue(locale);

      await page.goto(`${FRONTEND_URL}/app/agent`);
      await expectAccount(page, labels, driveTitle);
      await expectDriveMenu(page, labels, driveTitle);
      await page.reload();
      await expectAccount(page, labels, driveTitle);

      const screenshot = testInfo.outputPath(`account-${locale}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach(`Account settings (${locale})`, {
        path: screenshot,
        contentType: 'image/png',
      });

      // Open the same control after navigation, with no language-dependent
      // search filter. Check persistence before switching back.
      await page.goto(`${FRONTEND_URL}/app/settings`);
      await page.getByText(labels.appearance, { exact: true }).click();
      await expect(language).toHaveValue(locale);
      await language.selectOption('en');
      await page.getByText(english.appearance, { exact: true }).click();
      await expect(language).toHaveValue('en');
      await page.goto(`${FRONTEND_URL}/app/agent`);
      await expectAccount(page, english, driveTitle);
      await expectDriveMenu(page, english, driveTitle);
    });
  }
});
