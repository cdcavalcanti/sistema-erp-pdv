/** Retorno sonoro da leitura (seção 9): bipe curto de sucesso, duplo grave de erro. */
let ctx: AudioContext | null = null;

function tone(freq: number, ms: number, delay = 0) {
  try {
    ctx ??= new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq;
    g.gain.value = 0.08;
    o.connect(g).connect(ctx.destination);
    const t = ctx.currentTime + delay / 1000;
    o.start(t);
    o.stop(t + ms / 1000);
  } catch {
    /* sem áudio (navegador de teste) */
  }
}

export const beep = {
  ok: () => tone(1760, 70),
  error: () => {
    tone(220, 140);
    tone(180, 180, 170);
  },
};
