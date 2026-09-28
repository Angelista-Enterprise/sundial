import type { Config } from 'drizzle-kit';
import os from 'node:os';
import path from 'node:path';

const SUNDIAL_HOME = process.env.SUNDIAL_HOME || path.join(os.homedir(), '.sundial');
const DB_PATH = path.join(SUNDIAL_HOME, 'sundial.db');

export default {
  schema: './src/schemas/db-schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: `file:${DB_PATH}`,
  },
} satisfies Config;
