
import { IRDocument } from '../../ir/types';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';

export interface TestBackend {
  name: string;
  createContext: (ir: IRDocument, inputs?: Map<string, RuntimeValue>, builtins?: Map<string, RuntimeValue>) => Promise<EvaluationContext>;
  run: (ctx: EvaluationContext, entryPoint: string) => Promise<void>;
  execute: (ir: IRDocument, entryPoint: string, inputs?: Map<string, RuntimeValue>, builtins?: Map<string, RuntimeValue>) => Promise<EvaluationContext>;
}
