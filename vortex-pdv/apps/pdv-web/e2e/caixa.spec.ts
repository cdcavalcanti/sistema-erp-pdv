import { expect, test, type Page } from '@playwright/test';

/** Fluxos da frente de caixa contra o agente e o ERP reais (seção 53), na ordem de um turno. */
test.describe.configure({ mode: 'serial' });

const USERS = { ana: '482913', sup: '730184', ger: '915372' } as const;

async function login(page: Page, user: keyof typeof USERS = 'ana') {
  await page.goto('/');
  await page.getByLabel('Usuário').fill(user);
  await page.getByLabel('PIN').fill(USERS[user]);
  await page.keyboard.press('Enter');
  // Pronto quando aparece a abertura do caixa ou a frente de caixa
  await expect(page.getByLabel('Valor inicial (R$)').or(page.getByLabel('CÓDIGO / PRODUTO'))).toBeVisible();
}

async function scan(page: Page, code: string) {
  const input = page.getByLabel('CÓDIGO / PRODUTO');
  await input.fill(code);
  await input.press('Enter');
}

async function authorize(page: Page, user: keyof typeof USERS) {
  const dlg = page.getByRole('dialog', { name: 'Autorização do supervisor' });
  await expect(dlg).toBeVisible();
  await dlg.getByLabel('Usuário do supervisor').fill(user);
  await dlg.getByLabel('PIN').fill(USERS[user]);
  await dlg.getByLabel('PIN').press('Enter');
}

test('abertura do caixa, leitura com quantidade, produto não encontrado, consulta (F5) e venda em dinheiro com troco', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: /Abertura do caixa 03/ })).toBeVisible();
  await page.getByLabel('Valor inicial (R$)').fill('150,00');
  await page.keyboard.press('Enter');
  await scan(page, '2*CAFE-500');
  await expect(page.getByTestId('total')).toHaveText('R$ 49,80');
  await scan(page, 'NAO-EXISTE-123');
  await expect(page.getByRole('alert')).toContainText('Produto não encontrado');
  await page.keyboard.press('F5');
  const search = page.getByRole('dialog', { name: 'Consultar produto' });
  await search.getByLabel('Nome, descrição, SKU ou referência').fill('agua');
  await expect(search.getByRole('button', { name: /Água mineral/ })).toBeVisible();
  await search.getByLabel('Nome, descrição, SKU ou referência').press('Enter');
  await expect(page.getByTestId('total')).toHaveText('R$ 52,30');
  await page.keyboard.press('F9');
  const pay = page.getByRole('dialog', { name: /Pagamento/ });
  await pay.getByLabel('Valor recebido (R$)').fill('100,00');
  await expect(pay.getByText('R$ 47,70')).toBeVisible();
  await pay.getByLabel('Valor recebido (R$)').press('Enter');
  const done = page.getByRole('dialog', { name: 'Venda concluída' });
  await expect(done).toBeVisible();
  await expect(done.getByText('NFC-e autorizada')).toBeVisible();
  await expect(done.getByLabel('Comprovante')).toContainText('Troco R$');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('total')).toHaveText('R$ 0,00');
  // A venda chega ao ERP pela fila (sincronização a cada 2 s no teste)
  await page.keyboard.press('F11');
  const history = page.getByRole('dialog', { name: /Histórico/ });
  await expect(history.getByText('no ERP')).toBeVisible({ timeout: 15_000 });
  await expect(history.getByText('Dinheiro')).toBeVisible();
  // Detalhe da venda a partir do histórico
  await history.getByRole('row', { name: /PDV-03-/ }).first().click();
  await expect(page.getByRole('dialog', { name: /Venda PDV-03-/ }).getByRole('heading', { name: 'Itens' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('desconto acima do limite do operador pede o supervisor; cancelamento de item com motivo', async ({ page }) => {
  await login(page);
  await scan(page, 'CAMISETA-M');
  await scan(page, 'BISC-200');
  await expect(page.getByTestId('total')).toHaveText('R$ 57,40');
  await page.keyboard.press('F3');
  const disc = page.getByRole('dialog', { name: 'Desconto' });
  await disc.getByLabel('Percentual').fill('10');
  await disc.getByLabel('Percentual').press('Enter');
  await authorize(page, 'sup');
  await expect(page.getByTestId('total')).toHaveText('R$ 51,66');
  await page.getByRole('row', { name: /Biscoito/ }).click();
  await page.keyboard.press('F4');
  const cancel = page.getByRole('dialog', { name: /Cancelar item/ });
  await cancel.getByLabel('Motivo').selectOption('Registrado por engano');
  await cancel.getByRole('button', { name: /Cancelar item/ }).click();
  await expect(page.getByRole('row', { name: /Biscoito/ })).toContainText('CANCELADO');
  await expect(page.getByTestId('total')).toHaveText('R$ 44,91');
  // Cancelamento parcial: 3 cafés, cancela 2 escolhendo o item e a quantidade no modal
  await scan(page, '3*CAFE-500');
  await expect(page.getByTestId('total')).toHaveText('R$ 112,14');
  await page.keyboard.press('F4');
  const partial = page.getByRole('dialog', { name: /Cancelar item/ });
  await partial.getByLabel('Item').selectOption((await partial.locator('option', { hasText: 'Café' }).getAttribute('value'))!);
  await partial.getByLabel(/Quantidade a cancelar/).fill('2');
  await partial.getByRole('button', { name: /Cancelar 2 de 3/ }).click();
  await expect(page.getByRole('row', { name: /CANCELADO \(2 do item/ })).toBeVisible();
  await expect(page.getByTestId('total')).toHaveText('R$ 67,32');
  await page.keyboard.press('F9');
  await page.getByRole('dialog', { name: /Pagamento/ }).getByLabel('Valor recebido (R$)').press('Enter');
  await expect(page.getByRole('dialog', { name: 'Venda concluída' })).toBeVisible();
  await page.keyboard.press('Enter');
});

test('Pix só conclui com a confirmação do PSP (simulador de homologação)', async ({ page }) => {
  await login(page);
  await scan(page, 'CAFE-500');
  await page.keyboard.press('F9');
  const pay = page.getByRole('dialog', { name: /Pagamento/ });
  await pay.getByRole('radio', { name: /Pix/ }).click();
  await pay.getByRole('button', { name: /Receber Pix/ }).click();
  await expect(pay.getByText('Aguardando a confirmação do pagamento…')).toBeVisible();
  await expect(pay.getByRole('img', { name: 'QR Code Pix' })).toBeVisible();
  await page.waitForTimeout(2000);
  await expect(page.getByRole('dialog', { name: 'Venda concluída' })).toHaveCount(0);
  await pay.getByRole('button', { name: /Simular pagamento do cliente/ }).click();
  await expect(page.getByRole('dialog', { name: 'Venda concluída' })).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Enter');
});

test('sangria com supervisor e fechamento cego com conferência autorizado pelo gerente', async ({ page }) => {
  await login(page);
  await page.keyboard.press('F7');
  const sangria = page.getByRole('dialog', { name: 'Sangria' });
  await sangria.getByLabel('Valor (R$)').fill('100,00');
  await sangria.getByLabel('Valor (R$)').press('Enter');
  await authorize(page, 'sup');
  await expect(page.getByRole('status').filter({ hasText: 'Sangria de R$ 100,00 registrada' })).toBeVisible();
  await page.keyboard.press('F12');
  await page.getByRole('dialog', { name: 'Menu' }).getByRole('button', { name: /Fechar caixa/ }).click();
  const closing = page.getByRole('dialog', { name: 'Fechamento do caixa' });
  await expect(closing.getByText('fechamento cego')).toBeVisible();
  // Dinheiro: 150 abertura + 52,30 + 67,32 − 100 sangria = 169,62; operador conta 167,41
  await closing.getByLabel(/Dinheiro contado/).fill('167,41');
  await closing.getByLabel(/Pix conforme/).fill('24,90');
  await closing.getByRole('button', { name: /Fechar caixa/ }).click();
  await authorize(page, 'ger');
  const result = page.getByRole('dialog', { name: 'Caixa fechado' });
  await expect(result.getByRole('row', { name: /Dinheiro/ })).toContainText('-2,21');
  await expect(result.getByRole('row', { name: /Dinheiro/ })).toContainText('Falta');
  await expect(result.getByRole('row', { name: /Pix/ })).toContainText('Sem diferença');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: /Abertura do caixa 03/ })).toBeVisible();
});

test('@tablet frente de caixa usável no tablet, sem rolagem horizontal', async ({ page }) => {
  await login(page);
  const opening = page.getByLabel('Valor inicial (R$)');
  await expect(opening.or(page.getByLabel('CÓDIGO / PRODUTO'))).toBeVisible();
  if (await opening.isVisible()) {
    await opening.fill('0');
    await page.keyboard.press('Enter');
  }
  await scan(page, 'CAFE-500');
  await expect(page.getByTestId('total')).toHaveText('R$ 24,90');
  await expect(page.getByRole('button', { name: /FINALIZAR VENDA/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
