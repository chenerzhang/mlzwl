import { fileURLToPath } from 'node:url';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { CONFIG, type Config } from '../config/config.js';
import { openDatabase, type DatabaseHandle } from './database.js';

export const DB = Symbol('DB');
export const MIGRATIONS_DIR = Symbol('MIGRATIONS_DIR');

/** 迁移目录相对包根，dev（src）与 build（dist）都要能解析到。 */
function resolveMigrationsDir(): string {
  return fileURLToPath(new URL('../../drizzle', import.meta.url));
}

@Global()
@Module({
  providers: [
    { provide: MIGRATIONS_DIR, useFactory: resolveMigrationsDir },
    {
      provide: DB,
      inject: [CONFIG, MIGRATIONS_DIR],
      useFactory: async (config: Config, dir: string): Promise<DatabaseHandle> => openDatabase(config.DATA_DIR, dir),
    },
  ],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly handle: DatabaseHandle) {}

  onApplicationShutdown(): void {
    this.handle.close();
  }
}
