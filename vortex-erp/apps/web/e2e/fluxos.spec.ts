import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, user = 'gerente') {
  await page.goto('/entrar');
  await page.getByLabel('Empresa (identificador)').fill('e2e');
  await page.getByLabel('E-mail').fill(`${user}@e2e.local`);
  await page.getByLabel('Senha').fill(`vortex-${user}-123`);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('navigation')).toBeVisible();
}

test('pedido pelo teclado: cliente, produto, gravar e faturar com NF-e autorizada', async ({ page }) => {
  await login(page);
  await page.goto('/vendas/pedidos/novo');
  await expect(page.getByRole('heading', { name: 'Novo pedido' })).toBeVisible();
  // F4 cliente → digita → Enter escolhe; F2 produto → Enter inclui; Enter de novo soma 1
  await page.keyboard.press('F4');
  await page.keyboard.type('Mercadinho');
  await expect(page.getByRole('option', { name: /Mercadinho Boa Vista/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Mercadinho Boa Vista LTDA')).toBeVisible();
  await page.keyboard.press('F2');
  await page.keyboard.type('CAFE-500');
  await expect(page.getByRole('option', { name: /CAFE-500/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Quantidade CAFE-500')).toHaveValue('1');
  await page.getByLabel('Quantidade CAFE-500').fill('3');
  // 3 × R$ 24,90
  await expect(page.locator('.totals .grand')).toContainText('R$ 74,70');
  await page.keyboard.press('Control+Enter');
  await expect(page).toHaveURL(/\/vendas\/pedidos\/[0-9a-f-]{36}$/);
  await expect(page.locator('.page-head').getByText('Faturado (NF-e)', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Autorizada' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'DANFE' })).toBeVisible();
});

test('busca global (Ctrl+K) encontra cliente e abre o cadastro', async ({ page }) => {
  await login(page);
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder(/Buscar produto, cliente/).fill('Pão Quente');
  const hit = page.getByRole('option', { name: /Padaria Pão Quente/ });
  await expect(hit).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/pessoas\?abrir=/);
  await expect(page.getByRole('dialog', { name: 'Padaria Pão Quente ME' })).toBeVisible();
});

test('vendedor só vê o que o papel permite', async ({ page }) => {
  await login(page, 'vendedor');
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Pedidos' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Títulos' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Painel do dono' })).toHaveCount(0);
});

test('contas a pagar: o título lançado aparece com o saldo', async ({ page }) => {
  await login(page);
  await page.goto('/financeiro/titulos?tipo=payable');
  await expect(page.getByRole('heading', { name: 'Contas a pagar' })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'Distribuidora Nordeste SA' }).first()).toBeVisible();
});

test('@celular tela de pedido usável no celular, sem rolagem horizontal', async ({ page }) => {
  await login(page);
  await page.goto('/vendas/pedidos/novo');
  await expect(page.getByRole('heading', { name: 'Novo pedido' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole('combobox', { name: 'Cliente' }).fill('Maria');
  await page.getByRole('option', { name: /Maria das Graças/ }).click();
  await page.getByRole('combobox', { name: 'Produto' }).fill('AGUA');
  await page.getByRole('option', { name: /AGUA-500/ }).click();
  await expect(page.locator('.totals .grand')).toContainText('R$ 2,50');
  await page.getByRole('button', { name: /^Gravar F9/ }).click();
  await expect(page).toHaveURL(/\/vendas\/pedidos\/[0-9a-f-]{36}$/);
});

test('telas novas: painel, etapas do pedido, loja física, estoque, compras, impostos e conversa com a assistente', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await login(page);
  const nav = page.getByRole('navigation');
  const visit = async (link: string, heading: string) => {
    await nav.getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  };
  await visit('Painel do dono', 'Painel do dono');
  await expect(page.getByText('Pedidos em andamento')).toBeVisible();
  await visit('Pedidos', 'Pedidos');
  await page.getByRole('button', { name: /^Faturado/ }).click();
  await expect(page).toHaveURL(/etapa=invoiced/);
  await visit('Loja física (PDV)', 'Loja física (PDV)');
  await page.getByRole('tab', { name: 'Terminais' }).click();
  await expect(page.getByRole('heading', { name: 'Caixa 03' })).toBeVisible();
  await visit('Movimentações', 'Movimentações de estoque');
  await visit('Fornecedores', 'Fornecedores');
  await visit('Compras', 'Compras');
  await visit('Impostos (ICMS e outros)', 'Impostos');
  await expect(page.getByText(/Simples Nacional/).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Simulador de cálculo' }).click();
  await visit('Assistente IA', 'Assistente VORTEX');
  await page.getByRole('button', { name: 'Como está a operação hoje?' }).click();
  // Sem chave de IA no ambiente de teste: resposta por regras, com dados reais e salva na lista de conversas
  await expect(page.locator('.msg.assistant .md')).toContainText(/Faturamento|Vendas|pedidos/i);
  await expect(page.locator('.chat-item').first()).toBeVisible();
  expect(errors).toEqual([]);
});
