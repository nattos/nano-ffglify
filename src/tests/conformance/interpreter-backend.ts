import { RuntimeValue, EvaluationContext } from '../../interpreter/context';
import { InterpretedExecutor } from '../../interpreter/executor';
import { IRDocument } from '../../ir/types';
import { TestBackend } from './types';

export const InterpreterBackend: TestBackend = {
  name: 'Interpreter',
  createContext: async (ir: IRDocument, inputs: Map<string, RuntimeValue> = new Map(), builtins?: Map<string, RuntimeValue>) => {
    const ctx = new EvaluationContext(ir, inputs);
    if (builtins) {
      builtins.forEach((v, k) => ctx.builtins.set(k, v));
    }
    return ctx;
  },
  run: async (ctx: EvaluationContext, entryPoint: string) => {
    // Initialize viewport resources to default size (e.g. 64x64)
    // This ensures raymarcher works even if no explicit resize command is called
    ctx.resources.forEach((res, id) => {
      if (res.def.size.mode === 'viewport') {
        const width = 64;
        const height = 64;
        res.width = width;
        res.height = height;
        // Re-init data
        const count = width * height;
        if (res.def.persistence.clearValue !== undefined) {
          res.data = new Array(count).fill(res.def.persistence.clearValue);
        } else {
          res.data = new Array(count).fill(0);
        }
      }
    });

    const exec = new InterpretedExecutor(ctx);
    const func = ctx.ir.functions.find(f => f.id === entryPoint);
    if (!func) throw new Error(`Entry point '${entryPoint}' not found`);

    if (func.type === 'cpu') {
      ctx.pushFrame(entryPoint);
      exec.executeFunction(func);
    } else {
      ctx.pushFrame(entryPoint);
      exec.executeFunction(func);
    }
  },
  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map(), builtins?: Map<string, RuntimeValue>) => {
    const ctx = await InterpreterBackend.createContext(ir, inputs, builtins);
    await InterpreterBackend.run(ctx, entryPoint);
    return ctx;
  }
};
