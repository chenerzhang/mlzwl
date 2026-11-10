import { Global, Module } from '@nestjs/common';
import { HongguoService } from './hongguo.service.js';

@Global()
@Module({
  providers: [HongguoService],
  exports: [HongguoService],
})
export class HongguoModule {}
