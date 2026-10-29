import { useEffect } from 'react';
import { can, type Operator } from '../lib/types';
import { Modal } from '../ui';

export type MenuAction = 'closing' | 'return' | 'sales' | 'dashboard' | 'status' | 'sync' | 'settings' | 'logout';

const ITEMS: { a: MenuAction; label: string; key: string; perm?: string }[] = [
  { a: 'sales', label: 'Histórico de vendas (consultar, reimprimir, cancelar)', key: '1' },
  { a: 'return', label: 'Devolução', key: '2' },
  { a: 'closing', label: 'Fechar caixa', key: '3' },
  { a: 'dashboard', label: 'Painel operacional', key: '4', perm: 'pdv.relatorio.ver' },
  { a: 'status', label: 'Status dos serviços', key: '5' },
  { a: 'sync', label: 'Sincronizar agora', key: '6' },
  { a: 'settings', label: 'Parâmetros do terminal', key: '7', perm: 'pdv.parametro.configurar' },
  { a: 'logout', label: 'Sair (trocar operador)', key: '0' },
];

/** Menu (F12): funções fora do fluxo de venda. Teclas numéricas escolhem. */
export function MenuModal({ operator, onClose, onPick }: { operator: Operator; onClose: () => void; onPick: (a: MenuAction) => void }) {
  const items = ITEMS.filter((i) => !i.perm || can(operator, i.perm));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const it = items.find((i) => i.key === e.key);
      if (it) {
        e.preventDefault();
        onPick(it.a);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <Modal title="Menu" onClose={onClose}>
      <ul className="menu">
        {items.map((i, n) => <li key={i.a}><button type="button" className={n === 0 ? 'primary' : ''} onClick={() => onPick(i.a)}><kbd>{i.key}</kbd> {i.label}</button></li>)}
      </ul>
    </Modal>
  );
}
