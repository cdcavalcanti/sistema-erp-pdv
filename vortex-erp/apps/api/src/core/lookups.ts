import { cleanDoc, onlyDigits } from '@vortex/validators';

/** RN-CAD-04: consultas públicas para preencher cadastro (o usuário confirma). */
export interface CnpjInfo {
  cnpj: string;
  legalName: string;
  tradeName: string | null;
  registrationStatus: 'ativa' | 'suspensa' | 'inapta' | 'baixada' | 'nula';
  cnae: string | null;
  address: { zip: string; street: string; number: string; complement: string | null; district: string; cityName: string; cityIbge: string | null; uf: string } | null;
  phone: string | null;
  email: string | null;
  simplesNacional: boolean | null;
}

export interface CepInfo {
  zip: string;
  street: string;
  district: string;
  cityName: string;
  cityIbge: string;
  uf: string;
}

export interface PublicLookup {
  cnpj(cnpj: string): Promise<CnpjInfo | null>;
  cep(cep: string): Promise<CepInfo | null>;
}

const STATUS: Record<string, CnpjInfo['registrationStatus']> = { ATIVA: 'ativa', SUSPENSA: 'suspensa', INAPTA: 'inapta', BAIXADA: 'baixada', NULA: 'nula' };

/** Implementação HTTP: BrasilAPI (cadastro de CNPJ) e ViaCEP (CEP com código IBGE). */
export class HttpPublicLookup implements PublicLookup {
  async cnpj(cnpj: string): Promise<CnpjInfo | null> {
    const c = cleanDoc(cnpj);
    const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${c}`, { signal: AbortSignal.timeout(8000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Consulta de CNPJ indisponível (HTTP ${res.status})`);
    const d = (await res.json()) as Record<string, any>;
    return {
      cnpj: c,
      legalName: d.razao_social,
      tradeName: d.nome_fantasia || null,
      registrationStatus: STATUS[String(d.descricao_situacao_cadastral ?? '').toUpperCase()] ?? 'ativa',
      cnae: d.cnae_fiscal ? String(d.cnae_fiscal) : null,
      address: d.logradouro
        ? { zip: onlyDigits(String(d.cep ?? '')), street: `${d.descricao_tipo_de_logradouro ?? ''} ${d.logradouro}`.trim(), number: d.numero || 'S/N', complement: d.complemento || null,
            district: d.bairro, cityName: d.municipio, cityIbge: d.codigo_municipio_ibge ? String(d.codigo_municipio_ibge) : null, uf: d.uf }
        : null,
      phone: d.ddd_telefone_1 || null,
      email: d.email || null,
      simplesNacional: typeof d.opcao_pelo_simples === 'boolean' ? d.opcao_pelo_simples : null,
    };
  }

  async cep(cep: string): Promise<CepInfo | null> {
    const c = onlyDigits(cep);
    const res = await fetch(`https://viacep.com.br/ws/${c}/json/`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const d = (await res.json()) as Record<string, any>;
    if (d.erro) return null;
    return { zip: c, street: d.logradouro, district: d.bairro, cityName: d.localidade, cityIbge: d.ibge, uf: d.uf };
  }
}

/** Implementação determinística para testes e ambiente sem rede. */
export class FakePublicLookup implements PublicLookup {
  cnpjs = new Map<string, CnpjInfo>();
  async cnpj(cnpj: string) {
    return this.cnpjs.get(cleanDoc(cnpj)) ?? null;
  }
  async cep(cep: string) {
    const c = onlyDigits(cep);
    if (c === '50050000') return { zip: c, street: 'Rua da Aurora', district: 'Boa Vista', cityName: 'Recife', cityIbge: '2611606', uf: 'PE' };
    if (c === '01310100') return { zip: c, street: 'Avenida Paulista', district: 'Bela Vista', cityName: 'São Paulo', cityIbge: '3550308', uf: 'SP' };
    return null;
  }
}
