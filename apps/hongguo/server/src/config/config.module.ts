import { Global, Module } from '@nestjs/common';
import { CONFIG, loadConfig } from './config.js';

@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: () => loadConfig() }],
  exports: [CONFIG],
})
export class ConfigModule {}
