import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthContext';
import { LoginPage } from './LoginPage';

function setup() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><AuthProvider><LoginPage /></AuthProvider></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Login', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('valida com o mesmo esquema da API antes de enviar', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setup();
    await userEvent.type(screen.getByLabelText('E-mail'), 'nao-e-email');
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByText('E-mail inválido')).toBeInTheDocument();
    expect(screen.getByText('Informe o identificador da empresa')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pede o código do autenticador quando o perfil exige MFA', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'MFA_CODE_REQUIRED', message: 'Informe o código' }), { status: 401 })));
    setup();
    await userEvent.type(screen.getByLabelText('Empresa (identificador)'), 'demo');
    await userEvent.type(screen.getByLabelText('E-mail'), 'admin@demo.local');
    await userEvent.type(screen.getByLabelText('Senha'), 'segredo');
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(screen.getByLabelText('Código do aplicativo autenticador')).toBeInTheDocument());
  });
});
