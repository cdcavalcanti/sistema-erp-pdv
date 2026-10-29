/** Relógio injetável: os testes controlam o tempo (expiração de sessão, timeout de pagamento). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class ManualClock implements Clock {
  constructor(private t = new Date('2026-10-27T13:00:00.000Z')) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
  set(d: Date): void {
    this.t = new Date(d);
  }
}
