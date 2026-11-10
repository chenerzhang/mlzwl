import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/**
 * 用 Zod schema 校验 controller 的入参。
 *
 * 不用 `nestjs-zod`：它的 peer 只支持 Nest 10/11，而本项目用 Nest 12。
 * 这里 15 行就够，行为也更容易预测（失败时抛 400，body 是 Zod issue 数组）。
 */
@Injectable()
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.output<T> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((issue) => ({
          path: issue.path.map(String),
          code: issue.code,
          message: issue.message,
        })),
      );
    }
    return parsed.data;
  }
}
