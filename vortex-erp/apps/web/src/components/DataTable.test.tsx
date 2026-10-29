import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DataTable } from './DataTable';

// jsdom não mede elementos: dá tamanho à área de rolagem para a virtualização renderizar linhas
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1000 });
  HTMLElement.prototype.getBoundingClientRect = () => ({ width: 1000, height: 600, top: 0, left: 0, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
});

const rows = [
  { id: 'a', name: 'Café', total: '100.00' },
  { id: 'b', name: 'Arroz', total: '20.50' },
  { id: 'c', name: 'Biscoito', total: '3.10' },
];
const cols = [{ key: 'name', label: 'Produto' }, { key: 'total', label: 'Total', type: 'money' as const }];
const names = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('gridcell')[0]!.textContent);

describe('DataTable', () => {
  it('formata moeda, ordena pelo cabeçalho (texto e número decimal) e mostra o total de registros', () => {
    render(<DataTable rows={rows} columns={cols} rowKey={(r) => r.id} label="Itens" />);
    expect(screen.getByText('R$ 100,00')).toBeInTheDocument();
    expect(screen.getByText('3 registros')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('columnheader', { name: 'Produto' }));
    expect(names()).toEqual(['Arroz', 'Biscoito', 'Café']);
    fireEvent.click(screen.getByRole('columnheader', { name: /Total/ }));
    expect(names()).toEqual(['Biscoito', 'Arroz', 'Café']);
    fireEvent.click(screen.getByRole('columnheader', { name: /Total/ }));
    expect(names()).toEqual(['Café', 'Arroz', 'Biscoito']);
  });

  it('teclado: ↓ move a seleção e Enter abre a linha', () => {
    const onOpen = vi.fn();
    render(<DataTable rows={rows} columns={cols} rowKey={(r) => r.id} onOpen={onOpen} label="Itens" />);
    const grid = screen.getByRole('grid', { name: 'Itens' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith(rows[1]);
    fireEvent.keyDown(grid, { key: 'End' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(onOpen).toHaveBeenLastCalledWith(rows[2]);
  });

  it('lista vazia mostra a mensagem', () => {
    render(<DataTable rows={[]} columns={cols} rowKey={(r: { id: string }) => r.id} empty="Sem títulos" />);
    expect(screen.getByText('Sem títulos')).toBeInTheDocument();
  });
});
