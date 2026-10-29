import { useId, type CSSProperties } from 'react';
import { THEME_LABEL, useTheme, type ThemePreference } from './theme.js';

/**
 * Símbolo e wordmark da Vortex, redesenhados em vetor a partir da identidade visual.
 * As cores vêm de variáveis CSS, assim o mesmo desenho é prata no escuro e preto no claro:
 *   --vx-metal-1..4  degradê metálico do símbolo (no tema claro, as quatro com a cor da tinta)
 *   --vx-violet      detalhe violeta no centro do V (opcional, `glow`)
 *   --vx-word        cor do wordmark (padrão: currentColor)
 */

/** Metade esquerda do V (asa e lâmina interna); a direita é o espelho em x = 730. */
const WING = [[0, 0], [300, 175], [315, 198], [364, 548], [275, 258], [110, 148]];
const BLADE = [[140, 192], [257, 260], [362, 554]];
const mirror = (pts: number[][]) => pts.map(([x, y]) => [730 - x!, y!]);
const poly = (pts: number[][]) => pts.map((p) => p.join(',')).join(' ');

const stop = (v: string, fallback: string): CSSProperties => ({ stopColor: `var(${v}, ${fallback})` });

export interface SymbolProps {
  /** Altura em px (a largura acompanha a proporção do símbolo) */
  size?: number;
  /** Brilho violeta no centro do V ("detalhe violeta" da marca) */
  glow?: boolean;
  /** Texto para leitores de tela; sem ele o símbolo é decorativo */
  title?: string;
  className?: string;
}

export function VortexSymbol({ size = 28, glow = false, title, className }: SymbolProps) {
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 730 556" height={size} width={(size * 730) / 556} className={className} role={title ? 'img' : undefined}
      aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
      <defs>
        <linearGradient id={`m${id}`} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" style={stop('--vx-metal-1', '#fbfbfc')} />
          <stop offset="0.42" style={stop('--vx-metal-2', '#a9a9b1')} />
          <stop offset="0.62" style={stop('--vx-metal-3', '#e4e4e8')} />
          <stop offset="1" style={stop('--vx-metal-4', '#7d7d86')} />
        </linearGradient>
        {glow && (
          <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ ...stop('--vx-violet', '#6d4aff'), stopOpacity: 0 }} />
            <stop offset="1" style={{ ...stop('--vx-violet', '#6d4aff'), stopOpacity: 0.95 }} />
          </linearGradient>
        )}
      </defs>
      {glow && <polygon points="300,215 430,215 365,548" fill={`url(#g${id})`} />}
      <g fill={`url(#m${id})`}>
        <polygon points={poly(WING)} />
        <polygon points={poly(BLADE)} />
        <polygon points={poly(mirror(WING))} />
        <polygon points={poly(mirror(BLADE))} />
      </g>
    </svg>
  );
}

export interface WordmarkProps {
  /** Altura das letras em px */
  size?: number;
  title?: string;
  className?: string;
}

/** VORTEX em traço fino e geométrico, letras espaçadas como na marca. */
export function VortexWordmark({ size = 14, title = 'Vortex', className }: WordmarkProps) {
  return (
    <svg viewBox="-6 -6 1044 112" height={size * 1.12} width={(size * 1.12 * 1044) / 112} className={className} role="img" aria-label={title} focusable="false">
      <g fill="none" style={{ stroke: 'var(--vx-word, currentColor)' }} strokeWidth="10" strokeLinejoin="miter">
        <path d="M0,0 L62.5,94 L125,0" />
        <rect x="210" y="5" width="91" height="90" rx="20" />
        <path d="M390,100 V5 H462 Q480,5 480,23 V36 Q480,54 462,54 H390 M446,54 L486,100" />
        <path d="M565,5 H667 M616,5 V100" />
        <path d="M842,5 H752 V95 H842 M752,50 H834" />
        <path d="M924,0 L1030,100 M1030,0 L924,100" />
      </g>
    </svg>
  );
}

export interface LockupProps {
  /** Altura do símbolo; wordmark e assinatura são proporcionais */
  size?: number;
  glow?: boolean;
  /** Assinatura abaixo do nome; `false` omite */
  tagline?: string | false;
  className?: string;
}

/** Símbolo + wordmark + assinatura, empilhados como na identidade visual. */
export function VortexLockup({ size = 72, glow = false, tagline = 'AI OPERATING COMPANY', className }: LockupProps) {
  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: size * 0.3 }}>
      <VortexSymbol size={size} glow={glow} />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: size * 0.16 }}>
        <VortexWordmark size={size * 0.36} />
        {tagline && (
          <span style={{ fontSize: Math.max(9, size * 0.13), letterSpacing: '0.42em', marginRight: '-0.42em', fontWeight: 500, color: 'var(--vx-tagline, currentColor)', whiteSpace: 'nowrap' }}>
            {tagline}
          </span>
        )}
      </div>
    </div>
  );
}

const ICON: Record<ThemePreference, string> = {
  system: 'M3 5h18v11H3zM8 20h8M12 16v4',
  light: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  dark: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
};

/** Botão do tema: sistema → claro → escuro. Mostra a escolha atual. */
export function ThemeToggle({ className, showLabel = false }: { className?: string; showLabel?: boolean }) {
  const { preference, cycle } = useTheme();
  const next = THEME_LABEL[preference === 'system' ? 'light' : preference === 'light' ? 'dark' : 'system'];
  return (
    <button type="button" className={className} onClick={cycle} title={`${THEME_LABEL[preference]} (clique: ${next.toLowerCase()})`} aria-label={`${THEME_LABEL[preference]}. Trocar para ${next.toLowerCase()}`}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={ICON[preference]} />
      </svg>
      {showLabel && <span>{THEME_LABEL[preference]}</span>}
    </button>
  );
}
