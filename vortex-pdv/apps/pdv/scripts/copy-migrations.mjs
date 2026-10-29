import { cpSync } from 'node:fs';
cpSync('src/db/migrations', 'dist/src/db/migrations', { recursive: true });
