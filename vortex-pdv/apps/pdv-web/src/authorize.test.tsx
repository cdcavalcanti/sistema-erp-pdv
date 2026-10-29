import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { AuthorizationProvider, useAuthorized, type Authorization } from './authorize';
import { ApiError } from './lib/api';

function Harness({ action }: { action: (auth?: Authorization) => Promise<string> }) {
  const run = useAuthorized();
  const [out, setOut] = useState('');
  return <><button onClick={() => run(action).then(setOut, (e) => setOut(`erro: ${e.message}`))}>Agir</button><output>{out}</output></>;
}

describe('autorização do supervisor', () => {
  it('pede login e PIN quando o agente exige e repete a ação com a autorização; PIN errado pede de novo', async () => {
    const action = vi.fn(async (auth?: Authorization) => {
      if (!auth) throw new ApiError(403, 'AUTHORIZATION_REQUIRED', 'Desconto acima do seu limite', { permission: 'pdv.desconto.autorizar' });
      if (auth.pin !== '730184') throw new ApiError(401, 'INVALID_CREDENTIALS', 'Usuário ou PIN inválido');
      return `autorizado por ${auth.login}`;
    });
    const user = userEvent.setup();
    render(<AuthorizationProvider><Harness action={action} /></AuthorizationProvider>);
    await user.click(screen.getByRole('button', { name: 'Agir' }));
    expect(await screen.findByRole('dialog', { name: 'Autorização do supervisor' })).toBeInTheDocument();
    expect(screen.getByText(/desconto acima do seu limite/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Usuário do supervisor'), 'sup');
    await user.type(screen.getByLabelText('PIN'), '000000{Enter}');
    expect(await screen.findByText('Usuário ou PIN inválido')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('PIN'));
    await user.type(screen.getByLabelText('PIN'), '730184{Enter}');
    expect(await screen.findByText('autorizado por sup')).toBeInTheDocument();
    expect(action).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('cancelar a autorização devolve erro sem executar a ação', async () => {
    const action = vi.fn(async (auth?: Authorization) => {
      if (!auth) throw new ApiError(403, 'AUTHORIZATION_REQUIRED', 'Sangria: requer autorização do supervisor', { permission: 'pdv.caixa.sangria' });
      return 'ok';
    });
    const user = userEvent.setup();
    render(<AuthorizationProvider><Harness action={action} /></AuthorizationProvider>);
    await user.click(screen.getByRole('button', { name: 'Agir' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(await screen.findByText('erro: Autorização cancelada')).toBeInTheDocument();
    expect(action).toHaveBeenCalledTimes(1);
  });
});
