import { RuntimeValue, EvaluationContext } from '../../interpreter/context';
import { InterpretedExecutor } from '../../interpreter/executor';
import { IRDocument } from '../../ir/types';
import { TestBackend } from './types';

export const InterpreterBackend: TestBackend = {
  name: 'Interpreter',
  createContext: async (ir: IRDocument, inputs: Map<string, RuntimeValue> = new Map()) => {
    return new EvaluationContext(ir, inputs);
  },
  run: async (ctx: EvaluationContext, entryPoint: string) => {
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
  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map()) => {
    const ctx = await InterpreterBackend.createContext(ir, inputs);
    await InterpreterBackend.run(ctx, entryPoint);
    return ctx;
  }
};
