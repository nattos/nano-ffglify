import { FunctionDeclaration } from '@google/generative-ai/dist/generative-ai';
import { IRDocument, ValidationError } from '../domain/types';
import { LogicValidationError } from '../ir/validator';

// Standard Response Wrapper
export interface IREditResponse {
  success?: boolean;
  editApplied?: boolean;
  message: string;
  validationResult?: ValidationResult;
  compileResult?: CompileResult;
  docsResult?: FunctionDeclaration;
}

// Accpet the given IRDocument as is.
export type ReplaceIRRequest = IRDocument;

export interface PatchOperation {
  op: 'add' | 'remove' | 'replace';
  path: string; // e.g. "/relations" or "/relations/-" (append)
  value?: any;
}

export type PatchIRRequest = {
  patches: PatchOperation[]
}

export interface ValidationResult {
  success: boolean;
  errors?: ValidationError[];
}

export interface CompileResult {
  compileStatus: 'success' | 'fail' | 'timeout';
  errors?: LogicValidationError[];
}
